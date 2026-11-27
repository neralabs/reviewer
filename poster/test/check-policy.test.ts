import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_RULES, decideCheck, MAX_MARKED, parseCheckRule } from "../src/check-policy.ts";
import type { ModuleFinding, ModuleResult } from "../src/modules.ts";

let next = 0;
const finding = (level: ModuleFinding["level"], state: ModuleFinding["state"], over: Partial<ModuleFinding> = {}): ModuleFinding => ({
  module: "rerail",
  checkId: `no-${level}`,
  level,
  path: "src/a.ts",
  start: { line: 3, column: 1 },
  end: { line: 4, column: 1 },
  message: "msg",
  fingerprint: `fp${next++}`,
  state,
  ...over,
});

const result = (findings: ModuleFinding[], baseline?: ModuleResult["baseline"]): ModuleResult => ({
  schema: "reviewer.module-results/1",
  module: "rerail",
  version: "0.1.5",
  mode: "diff",
  status: "completed",
  checks: [],
  findings,
  ...(baseline ? { baseline } : {}),
});

const conclusions = (r: ModuleResult) => Object.fromEntries(CHECK_RULES.map((rule) => [rule, decideCheck(rule, r).conclusion]));

test("a change with nothing in its files passes every rule", () => {
  assert.deepEqual(conclusions(result([], { error: 0, warning: 0, note: 0 })), { "no-new": "success", "not-more": "success", zero: "success" });
});

test("what was already in the files fails only zero", () => {
  const r = result([finding("error", "existing"), finding("warning", "existing")], { error: 1, warning: 1, note: 0 });
  assert.deepEqual(conclusions(r), { "no-new": "success", "not-more": "success", zero: "failure" });
});

test("one new warning fails every rule when nothing was fixed for it", () => {
  const r = result([finding("warning", "new"), finding("error", "existing")], { error: 1, warning: 0, note: 0 });
  assert.deepEqual(conclusions(r), { "no-new": "failure", "not-more": "failure", zero: "failure" });
});

test("not-more lets a change trade one for another, and counts what it fixed in files it left clean", () => {
  // The base had two; the change fixed both and added one.
  const traded = result([finding("error", "new")], { error: 0, warning: 2, note: 0 });
  assert.deepEqual(conclusions(traded), { "no-new": "failure", "not-more": "success", zero: "failure" });
  assert.match(decideCheck("not-more", traded).title, /1 now, 2 on the merge base/);
  // The same number, but one more than the base had: errors and warnings are counted together.
  const more = result([finding("error", "new"), finding("warning", "existing"), finding("warning", "existing")], { error: 0, warning: 2, note: 0 });
  assert.equal(decideCheck("not-more", more).conclusion, "failure");
});

test("notes never fail a check, new or not, and the base's notes don't make room for errors", () => {
  const notes = result([finding("note", "new"), finding("note", "existing")], { error: 0, warning: 0, note: 0 });
  assert.deepEqual(conclusions(notes), { "no-new": "success", "not-more": "success", zero: "success" });
  const error = result([finding("error", "new")], { error: 0, warning: 0, note: 5 });
  assert.equal(decideCheck("not-more", error).conclusion, "failure");
});

test("not-more can't be decided without the merge base's counts, so it fails and says why", () => {
  const outcome = decideCheck("not-more", result([]));
  assert.equal(outcome.conclusion, "failure");
  assert.match(outcome.title, /no count for the merge base/);
  // The other rules don't need them.
  assert.equal(decideCheck("no-new", result([])).conclusion, "success");
  assert.equal(decideCheck("zero", result([])).conclusion, "success");
});

test("a module that failed fails the check under every rule, with its error shown as code and credentials taken out", () => {
  const failed: ModuleResult = { ...result([]), status: "failed", error: "rerail scan failed: token ghp_abcdefghijklmnopqrstuvwxyz0123 `<img src=x>`" };
  for (const rule of CHECK_RULES) {
    const outcome = decideCheck(rule, failed);
    assert.equal(outcome.conclusion, "failure", rule);
    assert.equal(outcome.title, "The check could not run");
    assert.deepEqual(outcome.marked, []);
    assert.ok(!outcome.summary.includes("ghp_"), "the token is redacted");
    assert.ok(outcome.summary.includes("`` rerail scan failed: token [redacted] `<img src=x>` ``"), outcome.summary);
  }
});

test("a result for a whole branch can't say what a change added, so it fails the check", () => {
  // In repository mode every finding is existing: read as a diff, no-new would pass whatever the branch held.
  const branch: ModuleResult = { ...result([finding("error", "existing")]), mode: "repository" };
  for (const rule of CHECK_RULES) {
    const outcome = decideCheck(rule, branch);
    assert.deepEqual([outcome.conclusion, outcome.title], ["failure", "The check could not run"], rule);
    assert.match(outcome.summary, /for a whole branch, not for this change/);
  }
});

test("the findings marked on their lines are the ones the rule is about: what fails the check first, notes last", () => {
  const findings = [
    finding("note", "existing", { path: "a.ts" }),
    finding("warning", "existing", { path: "b.ts" }),
    finding("note", "new", { path: "c.ts" }),
    finding("warning", "new", { path: "z.ts" }),
    finding("error", "new", { path: "m.ts", start: { line: 9, column: 1 } }),
    finding("error", "new", { path: "m.ts", start: { line: 2, column: 1 } }),
    finding("error", "existing", { path: "e.ts" }),
  ];
  const r = result(findings, { error: 1, warning: 1, note: 1 });
  const marked = (rule: (typeof CHECK_RULES)[number]) => decideCheck(rule, r).marked.map((f) => `${f.state} ${f.level} ${f.path}:${f.start.line}`);
  const fresh = ["new error m.ts:2", "new error m.ts:9", "new warning z.ts:3", "new note c.ts:3"];
  assert.deepEqual(marked("no-new"), fresh);
  assert.deepEqual(marked("not-more"), fresh);
  // Under zero the errors and warnings already there have to go too, and come before a note, which fails nothing.
  // An old note is nobody's job here.
  assert.deepEqual(marked("zero"), ["new error m.ts:2", "new error m.ts:9", "new warning z.ts:3", "existing error e.ts:3", "existing warning b.ts:3", "new note c.ts:3"]);
});

test("the summary counts new, existing and the merge base by level, and lists the checks, the ones with new findings first", () => {
  const r = result(
    [finding("error", "new", { checkId: "no-raw-sql" }), finding("error", "new", { checkId: "no-raw-sql" }), finding("warning", "existing", { checkId: "pack/no-console" }), finding("note", "new", { checkId: "prefer-const" })],
    { error: 0, warning: 4, note: 2 },
  );
  const { summary, title } = decideCheck("no-new", r);
  assert.equal(title, "New: 2 errors");
  assert.ok(summary.startsWith("`rerail` `0.1.5`, rule `no-new`: the change adds no error or warning.\n\n**Failed:** New: 2 errors."), summary);
  for (const row of [
    "| New in this change | 2 | 0 | 1 |",
    "| Already in the files changed | 0 | 1 | 0 |",
    "| On the merge base, same files | 0 | 4 | 2 |",
    "| `no-raw-sql` | error | 2 | 0 |",
    "| `pack/no-console` | warning | 0 | 1 |",
    "| `prefer-const` | note | 1 | 0 |",
  ]) {
    assert.ok(summary.includes(row), `${row}\n${summary}`);
  }
  // The checks with the most new findings come first; a check with only old findings comes last.
  const at = (id: string) => summary.indexOf(`| \`${id}\` |`);
  assert.ok(at("no-raw-sql") < at("prefer-const") && at("prefer-const") < at("pack/no-console"), summary);
  assert.ok(!decideCheck("no-new", result([])).summary.includes("merge base, same files"), "no row for counts the module didn't give");
});

test("a summary lists at most 30 checks and says how many more found something", () => {
  const many = Array.from({ length: 33 }, (_, i) => finding("warning", "new", { checkId: `check-${String(i).padStart(2, "0")}` }));
  const { summary } = decideCheck("no-new", result(many));
  assert.equal(summary.split("\n").filter((line) => line.startsWith("| `check-")).length, 30);
  assert.ok(summary.includes("| `check-29` |") && !summary.includes("| `check-30` |"), "equal counts list by id");
  assert.match(summary, /And 3 more checks with findings\./);
});

test("more findings than can be marked are still counted, and the summary says how many were marked", () => {
  const many = Array.from({ length: MAX_MARKED + 7 }, (_, i) => finding("warning", "new", { start: { line: i + 1, column: 1 } }));
  const outcome = decideCheck("no-new", result(many));
  assert.equal(outcome.marked.length, MAX_MARKED);
  assert.equal(outcome.title, `New: ${MAX_MARKED + 7} warnings`);
  assert.match(outcome.summary, new RegExp(`Only the first ${MAX_MARKED} of ${MAX_MARKED + 7} findings are marked`));
  // What is cut is what matters least: under zero, new notes go before any error that fails the check.
  const errors = Array.from({ length: MAX_MARKED }, (_, i) => finding("error", "existing", { start: { line: i + 1, column: 1 } }));
  const notes = Array.from({ length: 10 }, () => finding("note", "new"));
  assert.ok(decideCheck("zero", result([...notes, ...errors])).marked.every((f) => f.level === "error"));
});

test("an unknown rule is refused, by name", () => {
  assert.equal(parseCheckRule(" not-more\n"), "not-more");
  for (const text of ["", "none", "NO-NEW", "zero,no-new"]) assert.throws(() => parseCheckRule(text), /unknown check rule .*use no-new, not-more, zero/, text);
});
