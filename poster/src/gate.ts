// The gate turns one GitHub event into one decision. It holds no write
// credential and runs no PR code. I/O goes through GateDeps so the decision
// table is testable without GitHub.

import type { CiState } from "./ci.ts";
import { parseCommand, type Command } from "./commands.ts";
import { isDependencyAuthor, type ReviewConfig } from "./review-config.ts";
import { findingIdFromBody } from "./text.ts";

/** `scan`: a scheduled or manual run checks the branch with the modules (repository mode), with no model. */
export type Mode = "skip" | "review" | "rereview" | "help" | "stop" | "scan";

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
  /** REVIEW.md's settings at a base-branch ref. */
  reviewConfig(ref: string): Promise<ReviewConfig>;
  /** CI at a commit, leaving out this run's own checks. */
  ciState(sha: string): Promise<CiState>;
  /** Whether the bot already posted a review on this commit. */
  botReviewed(pr: number, sha: string): Promise<boolean>;
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
  /** What fired it: the team request, a comment, a reply on a finding thread, or CI finishing on a dependency PR. */
  trigger?: "team" | "command" | "thread" | "dependency";
  full?: boolean;
  feedback?: string;
  /** Finding the feedback is about, when it came as a reply on a finding thread. */
  findingId?: string;
  unknownCommand?: string;
}

const WRITE_PERMISSIONS = ["admin", "maintain", "write"];

interface WorkflowRun {
  event: string;
  conclusion: string | null;
  head_sha: string;
  pull_requests: { number: number }[];
}

interface EventPayload {
  action?: string;
  workflow_run?: WorkflowRun;
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

/** The run's PR, when the run is a successful pull_request run for exactly one PR. */
function runPr(payload: EventPayload): number | string {
  const run = payload.workflow_run;
  if (payload.action !== "completed" || !run) return `workflow_run.${payload.action} is not handled`;
  if (run.event !== "pull_request") return `the run was for ${run.event}, not a pull request`;
  if (run.conclusion !== "success") return `the run's conclusion is ${run.conclusion}`;
  if (run.pull_requests.length !== 1) return `the run is for ${run.pull_requests.length} pull requests in this repo, not one`;
  return run.pull_requests[0]!.number;
}

/** Facts from the PR itself that rule out an unasked review. */
function prStateProblem(pr: PullRequest, runSha: string): string | undefined {
  if (pr.state !== "open" || pr.draft) return "PR is not open, or is a draft";
  if ((pr.head.repo?.full_name ?? "") !== pr.base.repo.full_name) return "fork PR";
  return pr.head.sha === runSha ? undefined : `the run was for ${runSha.slice(0, 7)}, the head is now ${pr.head.sha.slice(0, 7)}`;
}

/** Why an open dependency PR isn't reviewed at this head, if it isn't. */
async function dependencyPrProblem(pr: PullRequest, runSha: string, deps: GateDeps): Promise<string | undefined> {
  const stateProblem = prStateProblem(pr, runSha);
  if (stateProblem) return stateProblem;
  if (!isDependencyAuthor(pr.user.login, await deps.reviewConfig(pr.base.ref))) return `${pr.user.login} is not a dependency bot in REVIEW.md`;
  if (await deps.botReviewed(pr.number, pr.head.sha)) return "the bot already reviewed this head";
  const ci = await deps.ciState(pr.head.sha);
  return ci === "pass" ? undefined : `CI is ${ci} at the head`;
}

/**
 * CI finished on a PR. Only a dependency bot's PR (REVIEW.md `dependencyUpdates.authors`, from the base branch) is
 * reviewed without a person asking, once per head and only when every check at the head is done and green, so the
 * review can approve. The caller lists the workflow (`workflow_run: workflows: [CI]`); every other PR still waits for
 * a person.
 */
async function onWorkflowRun(payload: EventPayload, deps: GateDeps): Promise<Decision> {
  const number = runPr(payload);
  if (typeof number === "string") return skip(number);
  const pr = await deps.pullRequest(number);
  const problem = await dependencyPrProblem(pr, payload.workflow_run!.head_sha, deps);
  if (problem) return skip(problem, number);
  return { mode: "review", reason: `CI passed on dependency PR by ${pr.user.login}`, trigger: "dependency", ...target(pr, pr.user.login) };
}

function onSchedule(eventName: string): Decision {
  return { mode: "scan", reason: `${eventName}: scan the branch with the modules` };
}

type Handler = (eventName: string, payload: EventPayload, cfg: GateConfig, deps: GateDeps) => Decision | Promise<Decision>;

const HANDLERS: Record<string, Handler> = {
  // Only pull_request_target: it runs the caller workflow from the base branch. On pull_request, GitHub runs
  // the PR's own copy, so a PR could rewrite the reviewer's configuration (approvals, ref) for itself.
  pull_request_target: (_event, payload, cfg, deps) => onPullRequest(payload, cfg, deps),
  // Runs the caller from the default branch, like pull_request_target. Sent by whoever pushed (often a bot).
  workflow_run: (_event, payload, _cfg, deps) => onWorkflowRun(payload, deps),
  issue_comment: onComment,
  pull_request_review_comment: onComment,
  // Both run the caller from the branch they name, which is merged code; workflow_dispatch needs write access.
  schedule: onSchedule,
  workflow_dispatch: onSchedule,
};

const BOT_EVENTS = ["pull_request_target", "workflow_run"];

export async function decide(eventName: string, payload: EventPayload, cfg: GateConfig, deps: GateDeps): Promise<Decision> {
  // pull_request_target filters bots itself; workflow_run reviews only a listed dependency bot's PR.
  if (payload.sender?.type === "Bot" && !BOT_EVENTS.includes(eventName)) return skip("event sent by a bot");
  const handler = Object.hasOwn(HANDLERS, eventName) ? HANDLERS[eventName] : undefined;
  return handler ? handler(eventName, payload, cfg, deps) : skip(`event ${eventName} is not handled`);
}
