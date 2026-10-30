import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, isHighRisk, parseReviewConfig } from "../src/review-config.ts";

const md = (block: string) => `# Review bar\n\nProse the model reads.\n\n\`\`\`json reviewer\n${block}\n\`\`\`\n\nMore prose.\n`;

test("no REVIEW.md, or one without a reviewer block, gives the defaults", () => {
  assert.deepEqual(parseReviewConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(parseReviewConfig("# Bar\n\n```json\n{\"highRiskPaths\": [\"x/\"]}\n```\n"), DEFAULT_CONFIG);
});

test("path lists add to the defaults", () => {
  const cfg = parseReviewConfig(md('{"highRiskPaths": ["native/src/engine/", "migrations/"]}'));
  assert.deepEqual(cfg.highRiskPaths, [...DEFAULT_CONFIG.highRiskPaths, "native/src/engine/", "migrations/"]);
});

test("largePrLines overrides the caller's threshold, up or down; unset leaves it to the caller", () => {
  assert.equal(parseReviewConfig(md('{"largePrLines": 120000}')).largePrLines, 120000);
  assert.equal(parseReviewConfig(md('{"largePrLines": 800}')).largePrLines, 800);
  assert.equal(parseReviewConfig(md('{"highRiskPaths": []}')).largePrLines, undefined);
});

test("a block that doesn't parse or has unknown keys is reported, with defaults kept", () => {
  for (const block of ["{not json", '{"maxChangedLines": 100}', '{"highRiskPath": ["src/"]}', '{"highRiskPaths": "src/"}', "[]", '{"largePrLines": 0}', '{"largePrLines": "50000"}']) {
    const cfg = parseReviewConfig(md(block));
    assert.ok(cfg.error, `expected an error for ${block}`);
    assert.deepEqual(cfg.highRiskPaths, DEFAULT_CONFIG.highRiskPaths);
  }
});

test("issue and pull request templates at the root are not high-risk; the rest of .github/ is", () => {
  for (const path of [
    ".github/ISSUE_TEMPLATE/1-bug.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/PULL_REQUEST_TEMPLATE/release.md",
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ]) {
    assert.equal(isHighRisk(path, DEFAULT_CONFIG), false, path);
  }
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    ".github/dependabot.yml",
    ".github/CODEOWNERS",
    ".github/secret_scanning.yml",
    ".github/ISSUE_TEMPLATE.md.bak",
    "packs/x/.github/ISSUE_TEMPLATE/bug.yml",
    "REVIEW.md",
  ]) {
    assert.equal(isHighRisk(path, DEFAULT_CONFIG), true, path);
  }
});

test("a repo keeps templates high-risk by listing them; listing .github/ again doesn't", () => {
  assert.equal(isHighRisk(".github/ISSUE_TEMPLATE/1-bug.yml", parseReviewConfig(md('{"highRiskPaths": [".github/ISSUE_TEMPLATE/"]}'))), true);
  assert.equal(isHighRisk(".github/ISSUE_TEMPLATE/1-bug.yml", parseReviewConfig(md('{"highRiskPaths": [".github/"]}'))), false);
});
