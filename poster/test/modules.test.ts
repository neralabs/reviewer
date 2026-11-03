import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lastLine, moduleTarget, newFindings, parseModuleResult, readModuleResults, runModules, type ModuleFinding } from "../src/modules.ts";

// Holds modules/todo (the example in docs/modules.md) and modules/broken.
const HOME = new URL("./fixtures", import.meta.url).pathname;

/** work/pr: a repository with origin/main, and a PR commit that adds one TODO next to one already on main. */
function workspace() {
  const work = mkdtempSync(join(tmpdir(), "modules-"));
  const pr = join(work, "pr");
  mkdirSync(pr);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: pr, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(pr, "old.ts"), "// TODO: from before\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(pr, "new.ts"), "export const x = 1;\n// TODO: added by the PR\n");
  git("add", "-A");
  git("commit", "-qm", "pr");
  return { work, base: git("rev-parse", "HEAD~1") };
}

test("modules run in diff mode against the base tip; a failing or unknown module is recorded and the rest go on", () => {
  const { work, base } = workspace();
  try {
    const target = moduleTarget(work, "diff", "main");
    assert.equal(target.baseSha, base);
    assert.equal(target.mergeBase, base);
    assert.ok(existsSync(join(target.baseCheckout, "old.ts")) && !existsSync(join(target.baseCheckout, "new.ts")), "base-tip is the base branch");

    const results = runModules(["todo", "broken", "nope", "Bad!", "todo"], target, { home: HOME, work });
    assert.deepEqual(
      results.map((r) => [r.module, r.status]),
      [
        ["todo", "completed"],
        ["broken", "failed"],
        ["nope", "failed"],
        ["unknown", "failed"],
      ],
    );
    assert.match(results[1]!.error ?? "", /run.sh exited 3/);
    assert.match(results[2]!.error ?? "", /no module nope/);
    const todo = results[0]!.findings.map((f) => [f.path, f.start.line, f.state]).sort();
    assert.deepEqual(todo, [
      ["new.ts", 2, "new"],
      ["old.ts", 1, "existing"],
    ]);
    assert.deepEqual(newFindings(results).map((f) => f.path), ["new.ts"]);
    // What later jobs read back is the checked result.
    assert.deepEqual(readModuleResults(work).map((r) => [r.module, r.status]), [["todo", "completed"], ["broken", "failed"], ["nope", "failed"]]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("in repository mode the branch is its own base and nothing is new", () => {
  const { work } = workspace();
  try {
    const target = moduleTarget(work, "repository", undefined);
    assert.equal(realpathSync(target.baseCheckout), realpathSync(join(work, "pr")));
    const [todo] = runModules(["todo"], target, { home: HOME, work });
    assert.equal(todo!.status, "completed");
    assert.equal(todo!.findings.length, 2);
    assert.ok(todo!.findings.every((f) => f.state === "existing"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

const finding = (over: Partial<ModuleFinding> = {}): ModuleFinding => ({
  module: "m",
  checkId: "c1",
  level: "warning",
  path: "src/a.ts",
  start: { line: 3, column: 1 },
  end: { line: 4, column: 1 },
  message: "msg",
  fingerprint: "abc123",
  state: "new",
  ...over,
});
const result = (findings: object[], over: object = {}) =>
  JSON.stringify({ schema: "reviewer.module-results/1", module: "m", version: "1", mode: "diff", status: "completed", checks: [{ id: "c1", level: "warning" }], findings, ...over });

test("a module's result must keep to the contract, or the whole result counts as failed", () => {
  assert.equal(parseModuleResult(result([finding()]), "m", "diff").status, "completed");
  assert.equal(parseModuleResult(result([finding({ path: "dir with space/a b.ts" })]), "m", "diff").status, "completed");
  for (const [text, why] of [
    ["not json", /not JSON/],
    [result([], { schema: "other/1" }), /is not reviewer.module-results\/1/],
    [result([], { module: "other" }), /is for other in diff mode/],
    [result([], { mode: "repository" }), /is for m in repository mode/],
    [result([], { status: "failed", error: "it broke" }), /it broke/],
    [result([], { checks: [{ id: "has space", level: "warning" }] }), /plain id/],
    [result([finding({ checkId: "c2" })]), /cites a check the result doesn't list/],
    [result([finding({ level: "fatal" as never })]), /has level "fatal"/],
    [result([finding({ path: "../etc/passwd" })]), /has path/],
    [result([finding({ path: "/abs" })]), /has path/],
    [result([finding({ start: { line: 0, column: 1 } })]), /1-based/],
    [result([finding({ fingerprint: "has space" })]), /fingerprint/],
    [result([finding({ state: "maybe" as never })]), /has state/],
    [result([finding({ module: "other" })]), /names module/],
  ] as const) {
    const parsed = parseModuleResult(text, "m", "diff");
    assert.equal(parsed.status, "failed", String(why));
    assert.match(parsed.error ?? "", why);
    assert.deepEqual(parsed.findings, []);
  }
});

test("repository mode marks everything existing, whatever the module said", () => {
  const parsed = parseModuleResult(result([finding()], { mode: "repository" }), "m", "repository");
  assert.equal(parsed.findings[0]!.state, "existing");
});

test("end is exclusive: a range ending at column 1 stops on the line before", () => {
  assert.equal(lastLine(finding({ start: { line: 12, column: 3 }, end: { line: 14, column: 20 } })), 14);
  assert.equal(lastLine(finding({ start: { line: 12, column: 3 }, end: { line: 14, column: 1 } })), 13);
  assert.equal(lastLine(finding({ start: { line: 4, column: 3 }, end: { line: 4, column: 1 } })), 4);
});

test("the example module in docs/modules.md is the one the tests run", () => {
  const doc = readFileSync(new URL("../../docs/modules.md", import.meta.url), "utf8");
  const example = readFileSync(join(HOME, "modules", "todo", "run.sh"), "utf8");
  assert.ok(doc.includes(example.trim()), "docs/modules.md should quote test/fixtures/modules/todo/run.sh verbatim");
});

test("checked module results, from the example module and from Rerail's, match schema/module-results.schema.json", async () => {
  const { Ajv } = await import("ajv");
  const schema = JSON.parse(readFileSync(new URL("../../schema/module-results.schema.json", import.meta.url), "utf8")) as object;
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  const { work } = workspace();
  try {
    const [todo] = runModules(["todo"], moduleTarget(work, "diff", "main"), { home: HOME, work });
    assert.ok(validate(todo), JSON.stringify(validate.errors));
    const { toResult, parseScan } = await import("../../modules/rerail/run.ts");
    const scan = parseScan(readFileSync(new URL("../../modules/rerail/test/fixtures/c3-scan-rerail.json", import.meta.url), "utf8"));
    const rerail = parseModuleResult(JSON.stringify(toResult(scan, "diff", new Set())), "rerail", "diff");
    assert.equal(rerail.status, "completed", rerail.error ?? "");
    assert.ok(validate(rerail), JSON.stringify(validate.errors));
    assert.ok(validate(parseModuleResult("nope", "m", "diff")), "a failed result is valid too");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
