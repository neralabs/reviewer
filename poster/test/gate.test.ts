import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, type GateConfig, type GateDeps, type PullRequest } from "../src/gate.ts";
import { findingMarker } from "../src/text.ts";

const cfg: GateConfig = { repo: { owner: "neralabs" }, teamSlug: "reviewer", handle: "@example-reviewer", botLogin: "example-reviewer[bot]" };

function pr(overrides: Partial<PullRequest> = {}, fork = false): PullRequest {
  return {
    number: 7,
    state: "open",
    draft: false,
    user: { login: "author", type: "User" },
    head: { sha: "head123", ref: "feature", repo: { full_name: fork ? "someone/rerail" : "neralabs/rerail" } },
    base: { sha: "base123", ref: "main", repo: { full_name: "neralabs/rerail" } },
    requested_teams: [],
    ...overrides,
  };
}

function deps(over: Partial<GateDeps> & { perms?: Record<string, string>; pull?: PullRequest } = {}): GateDeps {
  return {
    permission: async (user) => over.perms?.[user] ?? "write",
    pullRequest: async () => over.pull ?? pr(),
    reviewComment: over.reviewComment ?? (async () => ({ user: { login: "someone" }, body: "" })),
  };
}

const human = { login: "jeff", type: "User" };
const comment = (body: string, user = human) => ({
  action: "created",
  sender: user,
  issue: { number: 7, pull_request: {} },
  comment: { id: 1, body, user },
});

test("requesting the reviewer team reviews now; the request stays as the subscription", async () => {
  const d = await decide("pull_request_target", { action: "review_requested", sender: human, requested_team: { slug: "reviewer" }, pull_request: pr() }, cfg, deps());
  assert.equal(d.mode, "review");
  assert.equal(d.trigger, "team");
  assert.equal(d.headSha, "head123");
});

test("the bot requesting the team itself (review always, approving) doesn't start another review", async () => {
  const bot = { login: "example-reviewer[bot]", type: "Bot" };
  const d = await decide("pull_request_target", { action: "review_requested", sender: bot, requested_team: { slug: "reviewer" }, pull_request: pr() }, cfg, deps());
  assert.equal(d.mode, "skip");
});

test("requesting another team, or a user without write access, is ignored", async () => {
  const other = await decide("pull_request_target", { action: "review_requested", sender: human, requested_team: { slug: "platform-leads" }, pull_request: pr() }, cfg, deps());
  assert.equal(other.mode, "skip");
  const reader = await decide(
    "pull_request_target",
    { action: "review_requested", sender: human, requested_team: { slug: "reviewer" }, pull_request: pr() },
    cfg,
    deps({ perms: { jeff: "read" } }),
  );
  assert.equal(reader.mode, "skip");
});

test("comment commands map to modes, gated on write access", async () => {
  assert.equal((await decide("issue_comment", comment("@example-reviewer review"), cfg, deps())).mode, "review");
  const rereview = await decide("issue_comment", comment("@example-reviewer rereview the lock is held by the caller"), cfg, deps());
  assert.deepEqual([rereview.mode, rereview.feedback], ["rereview", "the lock is held by the caller"]);
  assert.equal((await decide("issue_comment", comment("@example-reviewer stop"), cfg, deps())).mode, "stop");
  assert.equal((await decide("issue_comment", comment("@example-reviewer help"), cfg, deps())).mode, "help");
  assert.equal((await decide("issue_comment", comment("@example-reviewer review"), cfg, deps({ perms: { jeff: "triage" } }))).mode, "skip");
});

test("the bot never acts on bot comments, and plain comments do nothing", async () => {
  assert.equal((await decide("issue_comment", comment("@example-reviewer review", { login: "example-reviewer[bot]", type: "Bot" }), cfg, deps())).mode, "skip");
  assert.equal((await decide("issue_comment", comment("LGTM"), cfg, deps())).mode, "skip");
});

test("commands addressed to the reviewer team count; other mentions of the team don't get a help reply", async () => {
  // People use the team as the bot's name; a command addressed to it must not be lost.
  const tim = await decide("issue_comment", comment("@neralabs/reviewer re review, that is not a blocker"), cfg, deps());
  assert.deepEqual([tim.mode, tim.feedback], ["rereview", "that is not a blocker"]);
  assert.equal((await decide("issue_comment", comment("@neralabs/reviewer review full"), cfg, deps())).full, true);
  assert.equal((await decide("issue_comment", comment("@neralabs/reviewer stop"), cfg, deps())).mode, "stop");
  assert.equal((await decide("issue_comment", comment("I requested @neralabs/reviewer on this one"), cfg, deps())).mode, "skip");
  assert.equal((await decide("issue_comment", comment("@neralabs/reviewers review"), cfg, deps())).mode, "skip");
  assert.equal((await decide("issue_comment", comment("@other-org/reviewer review"), cfg, deps())).mode, "skip");
});

test("comments on issues that aren't PRs are ignored", async () => {
  const d = await decide("issue_comment", { ...comment("@example-reviewer review"), issue: { number: 7 } }, cfg, deps());
  assert.equal(d.mode, "skip");
});

test("a review command on a closed PR is ignored, but stop still works", async () => {
  const closed = pr({ state: "closed" });
  assert.equal((await decide("issue_comment", comment("@example-reviewer review"), cfg, deps({ pull: closed }))).mode, "skip");
  assert.equal((await decide("issue_comment", comment("@example-reviewer stop"), cfg, deps({ pull: closed }))).mode, "stop");
});

test("drafts and forks are reviewed when someone with write access asks by comment", async () => {
  const d = await decide("issue_comment", comment("@example-reviewer review"), cfg, deps({ pull: pr({ draft: true }, true) }));
  assert.equal(d.mode, "review");
  assert.equal(d.isFork, true);
});

test("pushes and team-request removals do nothing, even on a PR the bot approved", async () => {
  // The bot's approval stands through later pushes (merge commits, follow-ups), like a human's.
  const teamRequested = pr({ requested_teams: [{ slug: "reviewer" }] });
  const push = await decide("pull_request_target", { action: "synchronize", sender: human, pull_request: teamRequested }, cfg, deps());
  assert.equal(push.mode, "skip");
  const removed = await decide("pull_request_target", { action: "review_request_removed", sender: human, requested_team: { slug: "reviewer" }, pull_request: pr() }, cfg, deps());
  assert.equal(removed.mode, "skip");
});

test("pull_request events are ignored: the PR controls that copy of the caller workflow", async () => {
  const d = await decide("pull_request", { action: "review_requested", sender: human, requested_team: { slug: "reviewer" }, pull_request: pr() }, cfg, deps());
  assert.equal(d.mode, "skip");
});

test("a reply on a bot finding thread is feedback on that finding", async () => {
  const reply = {
    action: "created",
    sender: human,
    pull_request: pr(),
    comment: { id: 2, body: "@example-reviewer intentional: callers hold the lock", user: human, in_reply_to_id: 1 },
  };
  const d = await decide(
    "pull_request_review_comment",
    reply,
    cfg,
    deps({ reviewComment: async () => ({ user: { login: "example-reviewer[bot]" }, body: `**[blocker] x**\n${findingMarker("B2")}` }) }),
  );
  assert.deepEqual([d.mode, d.findingId, d.feedback, d.trigger], ["rereview", "B2", "intentional: callers hold the lock", "thread"]);
});

test("a reply in a finding thread on a fork PR is skipped: it runs without secrets", async () => {
  const reply = {
    action: "created",
    sender: human,
    pull_request: pr({}, true),
    comment: { id: 2, body: "@example-reviewer intentional", user: human, in_reply_to_id: 1 },
  };
  const d = await decide(
    "pull_request_review_comment",
    reply,
    cfg,
    deps({ reviewComment: async () => ({ user: { login: "example-reviewer[bot]" }, body: `**[blocker] x**\n${findingMarker("B2")}` }) }),
  );
  assert.equal(d.mode, "skip");
  assert.match(d.reason, /fork PR thread replies get no secrets; comment "@example-reviewer rereview <feedback>" at top level/);
});
