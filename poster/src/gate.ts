// The gate turns one GitHub event into one decision. It holds no write
// credential and runs no PR code. I/O goes through GateDeps so the decision
// table is testable without GitHub.

import { parseCommand, type Command } from "./commands.ts";
import { findingIdFromBody } from "./text.ts";

export type Mode = "skip" | "review" | "rereview" | "help" | "stop";

export interface GateConfig {
  repo: { owner: string };
  teamSlug: string;
  /** Comment handle, e.g. "@neralabs-reviewer". */
  handle: string;
  /** The app's bot login, e.g. "neralabs-reviewer[bot]". */
  botLogin: string;
}

export interface PullRequest {
  number: number;
  state: string;
  draft: boolean;
  user: { login: string; type: string };
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
  /** Teams whose review is requested. The reviewer team stays here while the bot's approval stands. */
  requested_teams: { slug: string }[];
}

export interface GateDeps {
  permission(user: string): Promise<string>;
  pullRequest(number: number): Promise<PullRequest>;
  reviewComment(id: number): Promise<{ user: { login: string }; body: string }>;
}

export interface Decision {
  mode: Mode;
  reason: string;
  pr?: number;
  headSha?: string;
  headRepo?: string;
  baseRef?: string;
  isFork?: boolean;
  sender?: string;
  /** What fired it: the team request, a comment, or a reply on a finding thread. */
  trigger?: "team" | "command" | "thread";
  full?: boolean;
  feedback?: string;
  /** Finding the feedback is about, when it came as a reply on a finding thread. */
  findingId?: string;
  unknownCommand?: string;
}

const WRITE_PERMISSIONS = ["admin", "maintain", "write"];

interface EventPayload {
  action?: string;
  sender?: { login: string; type: string };
  requested_team?: { slug: string };
  pull_request?: PullRequest;
  issue?: { number: number; pull_request?: unknown };
  comment?: { id: number; body: string; user: { login: string; type: string }; in_reply_to_id?: number };
}

function skip(reason: string, pr?: number): Decision {
  return { mode: "skip", reason, pr };
}

function target(pr: PullRequest, sender: string): Pick<Decision, "pr" | "headSha" | "headRepo" | "baseRef" | "isFork" | "sender"> {
  const headRepo = pr.head.repo?.full_name ?? "";
  return {
    pr: pr.number,
    headSha: pr.head.sha,
    headRepo,
    baseRef: pr.base.ref,
    isFork: headRepo !== pr.base.repo.full_name,
    sender,
  };
}

async function canTrigger(deps: GateDeps, user: string): Promise<boolean> {
  return WRITE_PERMISSIONS.includes(await deps.permission(user));
}

// Only a person requesting the reviewer team counts. Pushes neither review nor withdraw an approval (the bot's
// approval stands like a human one), and removing the team request does nothing: the bot clears the request
// itself after each review, and `stop` withdraws an approval.
async function onPullRequest(payload: EventPayload, cfg: GateConfig, deps: GateDeps): Promise<Decision> {
  const pr = payload.pull_request!;
  const sender = payload.sender?.login ?? "";
  if (payload.action !== "review_requested") return skip(`pull_request.${payload.action} is not handled`, pr.number);
  if (payload.requested_team?.slug !== cfg.teamSlug) return skip("review requested from someone else", pr.number);
  // Only people ask for reviews; a bot's team request (another app's, or an old echo) is ignored.
  if (payload.sender?.type === "Bot") return skip("team requested by a bot", pr.number);
  // pull_request runs from forks get no secrets, so nothing could be posted.
  if ((pr.head.repo?.full_name ?? "") !== pr.base.repo.full_name) return skip(`fork PR: comment "${cfg.handle} review" instead`, pr.number);
  if (!(await canTrigger(deps, sender))) return skip(`${sender} lacks write access`, pr.number);
  return { mode: "review", reason: `team requested by ${sender}`, trigger: "team", ...target(pr, sender) };
}

/**
 * A command addressed to the reviewer team (`@neralabs/reviewer review`), which people use as the bot's
 * name. Only a known command, or feedback in a finding thread, counts: the team is also mentioned in
 * ordinary conversation ("requested @neralabs/reviewer"), which shouldn't get a help reply.
 */
function teamCommand(body: string, cfg: GateConfig, inBotThread: boolean): Command | undefined {
  const command = parseCommand(body, `@${cfg.repo.owner}/${cfg.teamSlug}`, inBotThread);
  return command?.kind === "help" && command.unknown !== undefined ? undefined : command;
}

async function onComment(eventName: string, payload: EventPayload, cfg: GateConfig, deps: GateDeps): Promise<Decision> {
  const comment = payload.comment!;
  if (payload.action !== "created") return skip(`comment ${payload.action}`);
  if (comment.user.type === "Bot" || comment.user.login === cfg.botLogin) return skip("comment by a bot");

  const number = eventName === "issue_comment" ? payload.issue?.number : payload.pull_request?.number;
  if (number === undefined || (eventName === "issue_comment" && !payload.issue?.pull_request)) return skip("comment is not on a pull request");

  // Review comments on a fork PR run without secrets (GitHub treats them like pull_request), so a thread
  // reply would fail at the token step. Top-level comments (issue_comment) do get secrets.
  if (eventName === "pull_request_review_comment" && payload.pull_request && (payload.pull_request.head.repo?.full_name ?? "") !== payload.pull_request.base.repo.full_name) {
    return skip(`fork PR thread replies get no secrets; comment "${cfg.handle} rereview <feedback>" at top level instead`, number);
  }

  let findingId: string | undefined;
  if (eventName === "pull_request_review_comment" && comment.in_reply_to_id) {
    const parent = await deps.reviewComment(comment.in_reply_to_id);
    if (parent.user.login === cfg.botLogin) findingId = findingIdFromBody(parent.body) ?? "";
  }
  const inBotThread = findingId !== undefined;
  const command = parseCommand(comment.body, cfg.handle, inBotThread) ?? teamCommand(comment.body, cfg, inBotThread);
  if (!command) return skip("no command", number);

  const sender = comment.user.login;
  if (!(await canTrigger(deps, sender))) return skip(`${sender} lacks write access`, number);

  const pr = await deps.pullRequest(number);
  const base = { ...target(pr, sender), trigger: inBotThread ? ("thread" as const) : ("command" as const) };
  if (command.kind === "help") return { mode: "help", reason: "help requested", unknownCommand: command.unknown, ...base };
  if (command.kind === "stop") return { mode: "stop", reason: `stop from ${sender}`, ...base };
  if (pr.state !== "open") return skip("PR is not open", number);

  if (command.kind === "review") return { mode: "review", reason: `review from ${sender}`, full: command.full, ...base };
  return {
    mode: "rereview",
    reason: `rereview from ${sender}`,
    feedback: command.feedback,
    findingId: findingId || undefined,
    ...base,
  };
}

export async function decide(eventName: string, payload: EventPayload, cfg: GateConfig, deps: GateDeps): Promise<Decision> {
  if (payload.sender?.type === "Bot" && eventName !== "pull_request_target") return skip("event sent by a bot");
  switch (eventName) {
    // Only pull_request_target: it runs the caller workflow from the base branch. On pull_request, GitHub runs
    // the PR's own copy, so a PR could rewrite the reviewer's configuration (approvals, ref) for itself.
    case "pull_request_target":
      return onPullRequest(payload, cfg, deps);
    case "issue_comment":
    case "pull_request_review_comment":
      return onComment(eventName, payload, cfg, deps);
    default:
      return skip(`event ${eventName} is not handled`);
  }
}
