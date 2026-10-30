// Responses that don't need the model: help, stop, withdrawing a stale
// approval, and reporting a failed run, plus managing the reviewer team's
// review request. All writes use the neralabs-reviewer token.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeBotApprovals, listReviews } from "./bot-history.ts";
import { HELP_TEXT } from "./commands.ts";
import type { Decision } from "./gate.ts";
import { fileAt, GitHub, type RepoRef } from "./github.ts";
import { parseReviewConfig } from "./review-config.ts";
import { appendSummary, requireEnv, type Settings } from "./settings.ts";

interface RequestedTeams {
  requested_teams: { slug: string }[];
}

// GitHub answers 2xx even when it ignores a team change it won't make (an app without the organization
// Members permission), so this reads the result back instead of trusting the status.

/** Removes the reviewer team's request. Returns whether it was requested; throws if GitHub kept the request. */
export async function removeTeamRequest(gh: GitHub, repo: RepoRef, pr: number, teamSlug: string): Promise<boolean> {
  const path = `/repos/${repo.owner}/${repo.repo}/pulls/${pr}`;
  const before = await gh.get<RequestedTeams>(path);
  if (!before.requested_teams.some((t) => t.slug === teamSlug)) return false;
  const after = await gh.request<RequestedTeams>("DELETE", `${path}/requested_reviewers`, { reviewers: [], team_reviewers: [teamSlug] });
  if (after.requested_teams.some((t) => t.slug === teamSlug)) {
    throw new Error(`GitHub kept the ${teamSlug} team request; neralabs-reviewer needs the organization Members (read) permission`);
  }
  return true;
}

export async function dismissApproval(gh: GitHub, repo: RepoRef, pr: number, reviewId: number, message: string): Promise<void> {
  await gh.request("PUT", `/repos/${repo.owner}/${repo.repo}/pulls/${pr}/reviews/${reviewId}/dismissals`, { message, event: "DISMISS" });
}

function comment(gh: GitHub, repo: RepoRef, pr: number, body: string): Promise<unknown> {
  return gh.request("POST", `/repos/${repo.owner}/${repo.repo}/issues/${pr}/comments`, { body });
}

/** Withdraws the bot's approval if one still counts. Returns whether there was one. */
async function withdrawApproval(s: Settings, write: GitHub, pr: number, why: string): Promise<boolean> {
  const read = new GitHub(requireEnv("GITHUB_TOKEN"));
  const approvals = activeBotApprovals(await listReviews(read, s.repo, pr), s.botLogin);
  for (const approval of approvals) await dismissApproval(write, s.repo, pr, approval.id, why);
  return approvals.length > 0;
}

/** mode is "failure" when the review or poster job failed; otherwise the gate's mode. */
export async function respond(s: Settings, mode: string): Promise<void> {
  const gate = JSON.parse(readFileSync(join(s.work, "gate.json"), "utf8")) as Decision;
  if (!gate.pr) throw new Error("respond needs a PR number from the gate");
  const write = new GitHub(requireEnv("APP_TOKEN"));
  const pr = gate.pr;

  switch (mode) {
    case "help": {
      const intro = gate.unknownCommand ? `I don't know the command \`${gate.unknownCommand.replace(/`/g, "")}\`. ` : "";
      // Same source as prepare: REVIEW.md on the base branch overrides the caller's default.
      const reviewMd = gate.baseRef ? await fileAt(new GitHub(requireEnv("GITHUB_TOKEN")), s.repo, "REVIEW.md", gate.baseRef) : undefined;
      const largePrLines = parseReviewConfig(reviewMd).largePrLines ?? s.largePrLines;
      await comment(write, s.repo, pr, `${intro}Here's what I respond to:\n\n${HELP_TEXT(s.handle, `@${s.repo.owner}/${s.teamSlug}`, largePrLines)}`);
      break;
    }
    case "stop": {
      const removed = await removeTeamRequest(write, s.repo, pr, s.teamSlug);
      const withdrawn = await withdrawApproval(s, write, pr, `Stopped by ${gate.sender}.`);
      await comment(
        write,
        s.repo,
        pr,
        `Stopped${removed ? `, removed @${s.repo.owner}/${s.teamSlug} from Reviewers` : ""}${withdrawn ? ", and withdrew my approval" : ""}. Any review in progress is cancelled. \`${s.handle} review\` starts again.`,
      );
      break;
    }
    case "failure":
      await comment(write, s.repo, pr, `A reviewer job failed; see the [run log](${s.runUrl}). \`${s.handle} review\` to try again.`);
      break;
    default:
      throw new Error(`respond: unknown mode ${mode}`);
  }
  appendSummary(`Responded to #${pr}: ${mode}.`);
}
