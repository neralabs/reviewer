import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commitProblem, dependencyExemption, fileProblem, isVersionOnly, versionShape, type ExemptionInput, type PrCommit, type PrFile } from "../src/dependency.ts";
import { DEFAULT_CONFIG, type ReviewConfig } from "../src/review-config.ts";

// Real Dependabot PRs on neralabs/rerail: #427 (GitHub Actions), #430 (Cargo), #431 (npm, with the pins push).
function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`fixtures/dependency/${name}.json`, import.meta.url), "utf8"), (_k, v) => (v === null ? undefined : v)) as T;
}

const config: ReviewConfig = {
  ...DEFAULT_CONFIG,
  dependencyUpdates: { authors: ["dependabot[bot]"], pushers: ["neralabs-ci[bot]"], pinFiles: ["scripts/host/install-omp-host.mjs"], knownGaps: {} },
};

function input(pr: number, over: Partial<ExemptionInput> = {}): ExemptionInput {
  return {
    author: "dependabot[bot]",
    isFork: false,
    config,
    commits: fixture<PrCommit[]>(`pr-${pr}-commits`),
    files: fixture<PrFile[]>(`pr-${pr}-files`),
    ...over,
  };
}

const patch = (removed: string[], added: string[]) => ["@@ -1,3 +1,3 @@", " {", ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`), " }"].join("\n");

test("real Dependabot PRs pass every guard: actions pins, Cargo lock, npm bump with its pins push", () => {
  for (const pr of [427, 430, 431]) assert.deepEqual(dependencyExemption(input(pr)), { dependencyPr: true, applies: true, failed: [] }, `#${pr}`);
});

test("a PR by anyone not listed gets no exemption and no dependency handling", () => {
  assert.deepEqual(dependencyExemption(input(431, { author: "jeff" })), { dependencyPr: false, applies: false, failed: [] });
  assert.equal(dependencyExemption(input(431, { config: DEFAULT_CONFIG })).dependencyPr, false);
  assert.equal(dependencyExemption(input(431, { config: { ...config, error: "bad block" } })).dependencyPr, false);
});

test("version-only diffs: versions, SHAs and # vX comments may change, nothing else", () => {
  assert.equal(versionShape(`    "marked": "18.0.11",`), versionShape(`    "marked": "18.1.2",`));
  assert.ok(isVersionOnly(patch([`  "esbuild": "0.28.2",`], [`  "esbuild": "0.28.3",`])));
  assert.ok(isVersionOnly(patch(["serde = { version = \"1.0.200\", features = [\"derive\"] }"], ["serde = { version = \"1.0.219\", features = [\"derive\"] }"])));
  assert.ok(isVersionOnly(patch([`uses: a/b@${"1".repeat(40)} # v7.6.0`], [`uses: a/b@${"2".repeat(40)} # v10.3.3`])));

  const changes: [string, string[], string[]][] = [
    ["new install script", [], [`    "postinstall": "node x.js",`]],
    ["new dependency", [`  "a": "1.0.0"`], [`  "a": "1.0.0",`, `  "evil": "1.0.0"`]],
    ["renamed dependency", [`  "lodash": "4.17.21",`], [`  "lodahs": "4.17.21",`]],
    ["source swapped", [`  "a": "1.0.0",`], [`  "a": "npm:evil@1.0.0",`]],
    ["action owner changed", [`uses: actions/checkout@${"1".repeat(40)}`], [`uses: evil/checkout@${"2".repeat(40)}`]],
    ["run step changed", ["run: npm ci"], ["run: curl x | sh"]],
    ["features changed", [`serde = { version = "1.0", features = [] }`], [`serde = { version = "1.1", features = ["x"] }`]],
  ];
  for (const [name, removed, added] of changes) assert.equal(isVersionOnly(patch(removed, added)), false, name);
});

test("each changed file must be a lock file, a pin file, or a manifest or workflow with a version-only diff", () => {
  const pins: string[] = ["pins/x.json"];
  const bump = patch([`  "a": "1.0.0",`], [`  "a": "1.0.1",`]);
  assert.equal(fileProblem({ filename: "package-lock.json", status: "modified" }, pins), undefined);
  assert.equal(fileProblem({ filename: "native/Cargo.lock", status: "modified" }, pins), undefined);
  assert.equal(fileProblem({ filename: "pins/x.json", status: "modified", patch: "@@ anything" }, pins), undefined);
  assert.equal(fileProblem({ filename: "packs/a/package.json", status: "modified", patch: bump }, pins), undefined);
  assert.equal(fileProblem({ filename: ".github/workflows/ci.yml", status: "modified", patch: bump }, pins), undefined);

  const refused: [PrFile, RegExp][] = [
    [{ filename: "src/index.ts", status: "modified", patch: bump }, /not a manifest/],
    [{ filename: "REVIEW.md", status: "modified", patch: bump }, /not a manifest/],
    [{ filename: ".github/dependabot.yml", status: "modified", patch: bump }, /not a manifest/],
    [{ filename: "CODEOWNERS", status: "modified", patch: bump }, /not a manifest/],
    [{ filename: "package.json", status: "added", patch: bump }, /added/],
    [{ filename: "package-lock.json", status: "removed" }, /removed/],
    [{ filename: "package.json", status: "modified" }, /no diff/],
    [{ filename: "package.json", status: "modified", patch: patch([], [`  "scripts": { "postinstall": "x" },`]) }, /more than version/],
    [{ filename: ".github/workflows/reviewer.yml", status: "modified", patch: patch(["      reviewer_ref: aaa1"], ["      reviewer_ref: aaa2"]) }, /reviewer's own pin/],
    [
      { filename: ".github/workflows/reviewer.yml", status: "modified", patch: patch([`    uses: neralabs/reviewer/.github/workflows/review.yml@${"1".repeat(40)} # v0.1.0`], [`    uses: neralabs/reviewer/.github/workflows/review.yml@${"2".repeat(40)} # v0.2.0`]) },
      /reviewer's own pin/,
    ],
  ];
  for (const [file, why] of refused) assert.match(fileProblem(file, pins) ?? "", why, file.filename);
});

test("commits: a listed bot's own, or GitHub's signed commit for it; nothing else", () => {
  const trusted = new Set(["dependabot[bot]", "neralabs-ci[bot]"]);
  const commit = (over: Partial<PrCommit> & { verified?: boolean } = {}): PrCommit => ({
    sha: "abcdef0123",
    author: { login: "dependabot[bot]" },
    committer: { login: "web-flow" },
    parents: [{}],
    commit: { verification: { verified: over.verified ?? true } },
    ...over,
  });
  assert.equal(commitProblem(commit(), trusted), undefined);
  assert.equal(commitProblem(commit({ author: { login: "neralabs-ci[bot]" }, committer: { login: "neralabs-ci[bot]" }, verified: false }), trusted), undefined);

  assert.match(commitProblem(commit({ verified: false }), trusted) ?? "", /committed by web-flow/);
  assert.match(commitProblem(commit({ author: { login: "jeff" }, committer: { login: "jeff" } }), trusted) ?? "", /by jeff/);
  assert.match(commitProblem(commit({ author: null }), trusted) ?? "", /unknown author/);
  assert.match(commitProblem(commit({ committer: { login: "jeff" } }), trusted) ?? "", /committed by jeff/);
  assert.match(commitProblem(commit({ parents: [{}, {}] }), trusted) ?? "", /merge commit/);
});

test("a person's commit on a Dependabot branch, a fork, or no commits turns the exemption off", () => {
  const pushed: PrCommit = { sha: "1234567890", author: { login: "jeff" }, committer: { login: "jeff" }, parents: [{}], commit: { verification: { verified: true } } };
  const withPush = dependencyExemption(input(431, { commits: [...fixture<PrCommit[]>("pr-431-commits"), pushed] }));
  assert.equal(withPush.applies, false);
  assert.match(withPush.failed.join("; "), /by jeff/);
  assert.match(dependencyExemption(input(431, { isFork: true })).failed.join("; "), /fork/);
  assert.match(dependencyExemption(input(431, { commits: [] })).failed.join("; "), /no commits/);
});

test("without the pin file listed, the npm PR's pins push keeps the exemption off", () => {
  const noPins = { ...config, dependencyUpdates: { ...config.dependencyUpdates!, pinFiles: [] } };
  const result = dependencyExemption(input(431, { config: noPins }));
  assert.equal(result.applies, false);
  assert.match(result.failed.join("; "), /install-omp-host\.mjs is not a manifest/);
});
