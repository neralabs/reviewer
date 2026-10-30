import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesAny, ownersOf, parseCodeowners } from "../src/patterns.ts";

// Cases from GitHub's CODEOWNERS documentation.
const cases: [pattern: string, path: string, matches: boolean][] = [
  ["*.js", "src/app/index.js", true],
  ["*.js", "src/app/index.ts", false],
  ["/build/logs/", "build/logs/today.log", true],
  ["/build/logs/", "src/build/logs/today.log", false],
  ["docs/*", "docs/getting-started.md", true],
  ["docs/*", "docs/build-app/troubleshooting.md", false],
  ["apps/", "apps/web/index.ts", true],
  ["apps/", "packages/apps/x.ts", true],
  ["/docs/", "docs/a.md", true],
  ["/docs/", "src/docs/a.md", false],
  ["**/logs", "deep/nested/logs/x.log", true],
  ["**/logs", "logs/x.log", true],
  ["/scripts/", "scripts/deploy.sh", true],
  ["docs", "docs/a/b.md", true],
  ["native/src/**", "native/src/engine/core.rs", true],
  ["native/src/**", "native/README.md", false],
  ["REVIEW.md", "REVIEW.md", true],
  ["REVIEW.md", "sub/REVIEW.md", true],
  ["/REVIEW.md", "sub/REVIEW.md", false],
  ["*", "anything/at/all.txt", true],
  ["file?.txt", "file1.txt", true],
  ["file?.txt", "file12.txt", false],
];

for (const [pattern, path, expected] of cases) {
  test(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
    assert.equal(matchesAny(path, [pattern]), expected);
  });
}

test("the last matching CODEOWNERS rule wins", () => {
  const rules = parseCodeowners(["# owners", "*       @neralabs/everyone", "*.rs    @alice @neralabs/engine  # engine", "/docs/  @bob"].join("\n"));
  assert.deepEqual(ownersOf("src/lib.rs", rules), ["@alice", "@neralabs/engine"]);
  assert.deepEqual(ownersOf("docs/x.rs", rules), ["@bob"]);
  assert.deepEqual(ownersOf("README.md", rules), ["@neralabs/everyone"]);
});

test("a rule with no owners unowns the path, and emails are not requestable owners", () => {
  const rules = parseCodeowners("* @alice\n/generated/\n/legal/ legal@example.com");
  assert.deepEqual(ownersOf("generated/x.ts", rules), []);
  assert.deepEqual(ownersOf("legal/terms.md", rules), []);
});
