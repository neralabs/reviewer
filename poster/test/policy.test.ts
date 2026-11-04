import assert from "node:assert/strict";
import { test } from "node:test";
import { decideEscalation, decideVerdict, type EscalationInput, type PolicyInput } from "../src/policy.ts";
import { DEFAULT_CONFIG } from "../src/review-config.ts";
import { parseCodeowners } from "../src/patterns.ts";

const lowRisk: PolicyInput = {
  findings: [{ level: "nit", path: "src/a.ts", needsRun: false }],
  ciState: "pass",
  changedPaths: ["src/a.ts", "src/b.ts"],
  config: DEFAULT_CONFIG,
  isFork: false,
  authorIsBot: false,
  headCurrent: true,
  approvalsEnabled: true,
  summaryOnly: false,
};

test("approves only when every low-risk rule holds", () => {
  assert.deepEqual(decideVerdict(lowRisk), { verdict: "approve", notApprovedBecause: [] });
});

test("each failed low-risk rule turns an approval into a comment and says why", () => {
  const variants: [Partial<PolicyInput>, RegExp][] = [
    [{ approvalsEnabled: false }, /approvals are off/],
    [{ findings: [{ level: "follow-up", path: "a", needsRun: true }] }, /local run/],
    [{ ciState: "pending" }, /CI is pending/],
    [{ ciState: "none" }, /CI is none/],
    [{ changedPaths: [".github/workflows/release.yml"] }, /high-risk/],
    [{ isFork: true }, /fork/],
    [{ authorIsBot: true }, /bot/],
    [{ headCurrent: false }, /new commits/],
    [{ summaryOnly: true }, /too large/],
    [{ config: { ...DEFAULT_CONFIG, error: "REVIEW.md reviewer block: bad" } }, /REVIEW\.md/],
  ];
  for (const [change, why] of variants) {
    const result = decideVerdict({ ...lowRisk, ...change });
    assert.equal(result.verdict, "comment", JSON.stringify(change));
    assert.match(result.notApprovedBecause.join("; "), why);
  }
});

test("PR size alone never stops an approval", () => {
  const changedPaths = Array.from({ length: 300 }, (_, i) => `src/module-${i}.ts`);
  assert.equal(decideVerdict({ ...lowRisk, changedPaths }).verdict, "approve");
});

test("a diff of issue and pull request templates can be approved; one that also touches a workflow can't", () => {
  const templates = [".github/ISSUE_TEMPLATE/1-bug.yml", ".github/ISSUE_TEMPLATE/config.yml", ".github/pull_request_template.md"];
  assert.equal(decideVerdict({ ...lowRisk, changedPaths: templates }).verdict, "approve");
  const withWorkflow = decideVerdict({ ...lowRisk, changedPaths: [...templates, ".github/workflows/ci.yml"] });
  assert.deepEqual(withWorkflow, { verdict: "comment", notApprovedBecause: ["the diff touches a high-risk path"] });
});

test("any blocker, new or still open, requests changes", () => {
  const result = decideVerdict({ ...lowRisk, findings: [{ level: "blocker", path: "src/a.ts", needsRun: false }] });
  assert.equal(result.verdict, "request_changes");
});

test("follow-ups and nits alone don't stop an approval", () => {
  const findings = [
    { level: "follow-up" as const, path: "packs/php/rules/x.json", needsRun: false },
    { level: "follow-up" as const, path: "test/x.test.ts", needsRun: false },
    { level: "nit" as const, path: "test/x.test.ts", needsRun: false },
  ];
  assert.equal(decideVerdict({ ...lowRisk, findings }).verdict, "approve");
});

const owners = parseCodeowners("* @neralabs/everyone\n/native/src/ @alice @neralabs/engine\n/docs/");
const esc: EscalationInput = {
  riskLevel: "low",
  modelNeeded: false,
  modelPaths: [],
  blockerPaths: [],
  changedPaths: ["native/src/core.rs", "docs/x.md"],
  codeowners: owners,
  author: "alice",
  reviewedHead: [],
};

test("no escalation for a low-risk review without owned blockers", () => {
  assert.equal(decideEscalation(esc).needed, false);
});

test("a blocker on an owned path escalates to its owners, never the author", () => {
  const result = decideEscalation({ ...esc, blockerPaths: ["native/src/core.rs"] });
  assert.deepEqual(result, { needed: true, owners: ["@neralabs/engine"], paths: ["native/src/core.rs"], noCodeowners: false });
});

test("a blocker on an unowned path alone does not escalate", () => {
  assert.equal(decideEscalation({ ...esc, blockerPaths: ["docs/x.md"] }).needed, false);
});

test("high risk with no named paths escalates over the changed files, skipping who already reviewed this head", () => {
  const result = decideEscalation({ ...esc, riskLevel: "high", author: "bob", reviewedHead: ["alice"] });
  assert.deepEqual(result.owners, ["@neralabs/engine"]);
});

test("without CODEOWNERS, escalation is needed but has nobody to request", () => {
  const result = decideEscalation({ ...esc, codeowners: undefined, modelNeeded: true });
  assert.deepEqual(result, { needed: true, owners: [], paths: esc.changedPaths, noCodeowners: true });
});

// Dependency PRs (dependency.ts decides `applies` from GitHub data; here only its effect on the verdict).
const depConfig = {
  ...DEFAULT_CONFIG,
  dependencyUpdates: { authors: ["dependabot[bot]"], pushers: [], pinFiles: [], knownGaps: { "pack-data": "OIDC jobs skip for Dependabot" } },
};
const depPr: PolicyInput = {
  ...lowRisk,
  config: depConfig,
  authorIsBot: true,
  changedPaths: ["package.json", "package-lock.json", ".github/workflows/ci.yml"],
  dependency: { applies: true, failed: [] },
};

test("an exempt dependency PR is approved despite high-risk paths and a bot author", () => {
  assert.deepEqual(decideVerdict(depPr), { verdict: "approve", notApprovedBecause: [] });
});

test("the exemption lifts only those two rules", () => {
  const variants: [Partial<PolicyInput>, RegExp][] = [
    [{ ciState: "pending" }, /CI is pending/],
    [{ headCurrent: false }, /new commits/],
    [{ isFork: true }, /fork/],
    [{ approvalsEnabled: false }, /approvals are off/],
    [{ summaryOnly: true }, /too large/],
  ];
  for (const [change, why] of variants) {
    const result = decideVerdict({ ...depPr, ...change });
    assert.equal(result.verdict, "comment", JSON.stringify(change));
    assert.match(result.notApprovedBecause.join("; "), why);
  }
  assert.equal(decideVerdict({ ...depPr, findings: [{ level: "blocker", path: "package.json", needsRun: false }] }).verdict, "request_changes");
});

test("a dependency PR the guards refuse keeps today's rules and says why", () => {
  const result = decideVerdict({ ...depPr, dependency: { applies: false, failed: ["commit 1234567 is by jeff, not a listed bot"] } });
  assert.equal(result.verdict, "comment");
  assert.deepEqual(result.notApprovedBecause, [
    "the diff touches a high-risk path",
    "the PR was opened by a bot",
    "not exempt as a dependency update: commit 1234567 is by jeff, not a listed bot",
  ]);
});

test("needs-run restating a declared known gap doesn't block an exempt dependency PR; any other needs-run does", () => {
  const gap = { level: "follow-up" as const, path: "package.json", needsRun: true, knownGap: "pack-data" };
  assert.equal(decideVerdict({ ...depPr, findings: [gap] }).verdict, "approve");
  assert.equal(decideVerdict({ ...depPr, findings: [{ ...gap, level: "nit" }] }).verdict, "approve");
  const blocked: [string, PolicyInput][] = [
    ["no knownGap", { ...depPr, findings: [{ ...gap, knownGap: undefined }] }],
    ["undeclared id", { ...depPr, findings: [{ ...gap, knownGap: "made-up" }] }],
    ["inherited key", { ...depPr, findings: [{ ...gap, knownGap: "constructor" }] }],
    ["not exempt", { ...depPr, dependency: { applies: false, failed: ["x"] }, findings: [gap] }],
    ["not a dependency PR", { ...lowRisk, config: depConfig, findings: [gap] }],
  ];
  for (const [name, input] of blocked) assert.match(decideVerdict(input).notApprovedBecause.join("; "), /local run/, name);
});
