import assert from "node:assert/strict";
import { test } from "node:test";
import type { CiState } from "../src/ci.ts";
import { decide, type GateConfig, type GateDeps, type PullRequest } from "../src/gate.ts";
import { DEFAULT_CONFIG, type ReviewConfig } from "../src/review-config.ts";
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

type DepsOver = Partial<GateDeps> & { perms?: Record<string, string>; pull?: PullRequest; config?: ReviewConfig; ci?: CiState; reviewed?: boolean };

function deps(over: DepsOver = {}): GateDeps {
  return {
    permission: async (user) => over.perms?.[user] ?? "write",
    pullRequest: async () => over.pull ?? pr(),
    reviewComment: over.reviewComment ?? (async () => ({ user: { login: "someone" }, body: "" })),
    reviewConfig: async () => over.config ?? DEFAULT_CONFIG,
    ciState: async () => over.ci ?? "pass",
    botReviewed: async () => over.reviewed ?? false,
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

test("a scheduled or manual run is a scan of the branch; other events, and inherited object keys, are ignored", async () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const d = await decide(event, { sender: human }, cfg, deps());
    assert.equal(d.mode, "scan", event);
    assert.equal(d.pr, undefined);
  }
  assert.equal((await decide("push", { sender: human }, cfg, deps())).mode, "skip");
  assert.equal((await decide("toString", { sender: human }, cfg, deps())).mode, "skip");
});

// Dependency PRs: CI finishing (workflow_run) reviews a listed bot's PR without anyone asking.
const dependabot = { login: "dependabot[bot]", type: "Bot" };
const depConfig: ReviewConfig = { ...DEFAULT_CONFIG, dependencyUpdates: { authors: ["dependabot[bot]"], pushers: ["neralabs-ci[bot]"], pinFiles: [], knownGaps: {} } };
const depPr = (over: Partial<PullRequest> = {}) => pr({ user: dependabot, ...over });
const ciDone = (over: Record<string, unknown> = {}, sender = dependabot) => ({
  action: "completed",
  sender,
  workflow_run: { event: "pull_request", conclusion: "success", head_sha: "head123", pull_requests: [{ number: 7 }], ...over },
});

test("CI passing on a listed dependency bot's PR starts a review, even though a bot sent the event", async () => {
  const d = await decide("workflow_run", ciDone(), cfg, deps({ pull: depPr(), config: depConfig }));
  assert.deepEqual([d.mode, d.trigger, d.pr, d.headSha, d.isFork], ["review", "dependency", 7, "head123", false]);
  // The pins workflow's push: CI ran as that bot, the PR is still Dependabot's.
  const pins = await decide("workflow_run", ciDone({}, { login: "neralabs-ci[bot]", type: "Bot" }), cfg, deps({ pull: depPr(), config: depConfig }));
  assert.equal(pins.mode, "review");
});

test("a CI run reviews nothing unless every condition holds", async () => {
  const cases: [string, Record<string, unknown>, DepsOver, RegExp][] = [
    ["requested", { action: "requested" }, {}, /not handled/],
    ["push run", { workflow_run: { ...ciDone().workflow_run, event: "push" } }, {}, /push/],
    ["failed run", { workflow_run: { ...ciDone().workflow_run, conclusion: "failure" } }, {}, /failure/],
    ["no PR (a fork's run lists none)", { workflow_run: { ...ciDone().workflow_run, pull_requests: [] } }, {}, /0 pull requests/],
    ["a person's PR", {}, { pull: pr() }, /not a dependency bot/],
    ["no dependencyUpdates", {}, { config: DEFAULT_CONFIG }, /not a dependency bot/],
    ["broken REVIEW.md", {}, { config: { ...depConfig, error: "bad" } }, /not a dependency bot/],
    ["stale run", { workflow_run: { ...ciDone().workflow_run, head_sha: "old456" } }, {}, /head is now/],
    ["closed PR", {}, { pull: depPr({ state: "closed" }) }, /not open/],
    ["draft PR", {}, { pull: depPr({ draft: true }) }, /draft/],
    ["fork PR", {}, { pull: { ...depPr(), head: { sha: "head123", ref: "x", repo: { full_name: "someone/rerail" } } } }, /fork/],
    ["already reviewed", {}, { reviewed: true }, /already reviewed/],
    ["other checks still running", {}, { ci: "pending" }, /CI is pending/],
    ["another check failed", {}, { ci: "fail" }, /CI is fail/],
  ];
  for (const [name, payload, over, why] of cases) {
    const d = await decide("workflow_run", { ...ciDone(), ...payload }, cfg, deps({ pull: depPr(), config: depConfig, ...over }));
    assert.equal(d.mode, "skip", name);
    assert.match(d.reason, why, name);
  }
});

test("bots still can't trigger anything else", async () => {
  const d = await decide("issue_comment", { ...comment("@example-reviewer review", dependabot) }, cfg, deps());
  assert.equal(d.mode, "skip");
});
