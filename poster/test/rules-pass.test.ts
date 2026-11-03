import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renumberWithOverlaps } from "../src/findings.ts";
import type { ModuleFinding, ModuleResult } from "../src/modules.ts";
import { inlineBody, summaryBody, type Finding } from "../src/render.ts";
import {
  annotate,
  findingsToRecommend,
  loadRulesPass,
  mergeRulesPass,
  prepareRulesPass,
  readRulesPassOutput,
  rulePriorRulings,
  storedSource,
  type Recommendation,
} from "../src/rules-pass.ts";
import type { StoredFinding } from "../src/text.ts";

const mf = (over: Partial<ModuleFinding> = {}): ModuleFinding => ({
  module: "rerail",
  checkId: "no-raw-sql",
  level: "warning",
  path: "src/db.ts",
  start: { line: 12, column: 3 },
  end: { line: 14, column: 20 },
  message: "Build queries with the query builder.",
  fingerprint: "fp1",
  state: "new",
  ...over,
});
const results = (findings: ModuleFinding[], over: Partial<ModuleResult> = {}): ModuleResult[] => [
  { schema: "reviewer.module-results/1", module: "rerail", version: "0.2.0", mode: "diff", status: "completed", checks: [{ id: "no-raw-sql", level: "warning" }], findings, ...over },
];
const p1 = (over: Partial<Finding> = {}): Finding => ({
  id: "F1",
  level: "follow-up",
  path: "src/db.ts",
  line: 12,
  title: "String-built SQL",
  evidence: "e",
  fix: "f",
  confidence: "high",
  needsRun: false,
  ...over,
});
const rec = (over: Partial<Recommendation> = {}): Recommendation => ({ fingerprint: "fp1", action: "add", level: "blocker", title: "Raw SQL", evidence: "ev", fix: "fx", ...over });
const stored = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  id: "B7",
  level: "blocker",
  path: "src/db.ts",
  line: 12,
  title: "Raw SQL",
  status: "open",
  src: "rules",
  module: "rerail",
  check: "no-raw-sql",
  fp: "fp1",
  ...over,
});

test("an added finding's place and check come from the module, never the model, and its level is capped", () => {
  const sneaky = { ...rec(), path: "elsewhere.ts", line: 999 } as Recommendation;
  const { added } = mergeRulesPass([], [mf()], { summary: "s", recommendations: [sneaky] });
  assert.equal(added.length, 1);
  assert.deepEqual([added[0]!.path, added[0]!.line, added[0]!.endLine, added[0]!.level], ["src/db.ts", 12, 14, "blocker"]);
  assert.deepEqual(added[0]!.source, { pass: "rules", module: "rerail", checkId: "no-raw-sql", fingerprint: "fp1" });

  // A note can't become a blocker; the model may lower a level but not raise it.
  const note = mergeRulesPass([], [mf({ level: "note" })], { summary: "s", recommendations: [rec({ level: "blocker" })] });
  assert.equal(note.added[0]!.level, "follow-up");
  const lowered = mergeRulesPass([], [mf()], { summary: "s", recommendations: [rec({ level: "nit" })] });
  assert.equal(lowered.added[0]!.level, "nit");
});

test("an overlap marks the first-pass finding without changing it, unless the rule breach is more severe", () => {
  const first = [p1({ id: "B1", level: "blocker" }), p1({ id: "F2" })];
  const same = mergeRulesPass(first, [mf()], { summary: "s", recommendations: [rec({ action: "overlap", overlapsWith: "B1" })] });
  assert.deepEqual(same.added, []);
  assert.deepEqual(same.alsoBreaks, { B1: [{ module: "rerail", checkId: "no-raw-sql" }] });
  const marked = annotate(first, same.alsoBreaks);
  assert.deepEqual(marked[0], { ...first[0], alsoBreaks: [{ module: "rerail", checkId: "no-raw-sql" }] });
  assert.equal(marked[1], first[1]);

  // The first pass called it a follow-up; the rules pass says the breach blocks: posted on its own, pointing at F2.
  const worse = mergeRulesPass(first, [mf()], { summary: "s", recommendations: [rec({ action: "overlap", overlapsWith: "F2" })] });
  assert.deepEqual(worse.alsoBreaks, {});
  assert.equal(worse.added[0]!.level, "blocker");
  assert.equal(worse.added[0]!.source?.overlaps, "F2");
});

test("dismissals are listed; unknown or repeated fingerprints are ignored; a finding the model skipped is still posted", () => {
  const given = [mf(), mf({ fingerprint: "fp2", checkId: "no-console", path: "src/log.ts", start: { line: 4, column: 1 }, end: { line: 4, column: 9 }, message: "Use the logger." })];
  const merged = mergeRulesPass([], given, {
    summary: "s",
    recommendations: [rec({ action: "dismiss", evidence: "only a comment" }), rec({ fingerprint: "fp1" }), rec({ fingerprint: "made-up" })],
  });
  assert.deepEqual(merged.dismissed, [{ module: "rerail", checkId: "no-raw-sql", path: "src/db.ts", line: 12, why: "only a comment" }]);
  assert.equal(merged.ignored, 2);
  assert.equal(merged.added.length, 1);
  assert.deepEqual([merged.added[0]!.path, merged.added[0]!.level, merged.added[0]!.title], ["src/log.ts", "blocker", "no-console: Use the logger."]);
});

test("the rules pass gets only new findings not reported before, and its inputs never land in the first pass's bundle", () => {
  const all = results([mf(), mf({ fingerprint: "fp2" }), mf({ fingerprint: "fp3", state: "existing" })]);
  const toRecommend = findingsToRecommend(all, [stored({ fp: "fp1" })]);
  assert.deepEqual(toRecommend.map((f) => f.fingerprint), ["fp2"]);

  const work = mkdtempSync(join(tmpdir(), "rules-pass-"));
  try {
    mkdirSync(join(work, "context"));
    assert.equal(prepareRulesPass(join(work, "rules-pass"), [p1()], toRecommend), 1);
    assert.deepEqual(readdirSync(join(work, "rules-pass", "input")).sort(), ["module-findings.json", "pass1-findings.json", "prompt.md"]);
    assert.deepEqual(readdirSync(join(work, "context")), []);
    const given = JSON.parse(readFileSync(join(work, "rules-pass", "input", "module-findings.json"), "utf8")) as ModuleFinding[];
    assert.equal(given[0]!.fingerprint, "fp2");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("earlier rules-pass findings are fixed or open by fingerprint, with no model", () => {
  const prior = [stored({ id: "B1", fp: "gone" }), stored({ id: "B2", fp: "fp1" }), stored({ id: "F3", src: undefined })];
  assert.deepEqual(rulePriorRulings(prior, results([mf()])), [
    { id: "B1", status: "fixed", evidence: "rerail no longer finds no-raw-sql" },
    { id: "B2", status: "open", evidence: "rerail still finds no-raw-sql" },
  ]);
  assert.deepEqual(
    rulePriorRulings(prior, results([], { status: "failed" })).map((r) => [r.id, r.status]),
    [
      ["B1", "open"],
      ["B2", "open"],
    ],
  );
});

test("the poster's view: without the rules pass's output the first pass posts alone, with a note", () => {
  const work = mkdtempSync(join(tmpdir(), "rules-load-"));
  try {
    const missing = loadRulesPass(work, [p1()], results([mf()]), []);
    assert.deepEqual(missing.added, []);
    assert.match(missing.notes.join("\n"), /Rules pass:\*\* didn't complete, so 1 new module findings/);

    const failedModule = loadRulesPass(work, [], results([], { status: "failed", error: "rerail: engine missing" }), []);
    assert.match(failedModule.notes.join("\n"), /rerail didn't complete \(rerail: engine missing\)/);

    mkdirSync(join(work, "rules-pass"));
    writeFileSync(join(work, "rules-pass", "rules-pass.json"), JSON.stringify({ summary: "One raw query @someone", recommendations: [rec()] }));
    const ran = loadRulesPass(work, [p1()], results([mf()]), []);
    assert.equal(ran.added.length, 1);
    assert.match(ran.notes.at(-1)!, /^\*\*Rules pass\*\* \(1 added, 0 on first-pass findings, 0 dismissed as false positives\): One raw query @⁠someone/);

    writeFileSync(join(work, "rules-pass", "rules-pass.json"), JSON.stringify({ summary: "s", recommendations: [{ ...rec(), action: "rewrite" }] }));
    assert.equal(readRulesPassOutput(join(work, "rules-pass", "rules-pass.json")), undefined);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("renumbering keeps each overlap pointing at its first-pass finding", () => {
  const added = mergeRulesPass([p1({ id: "F2" })], [mf()], { summary: "s", recommendations: [rec({ action: "overlap", overlapsWith: "F2" })] }).added;
  // F2 was already used by an earlier review, so the first-pass finding becomes F3.
  const fresh = renumberWithOverlaps([p1({ id: "F2" }), ...added], ["F2"]);
  assert.equal(fresh[0]!.id, "F3");
  assert.equal(fresh[1]!.source?.overlaps, "F3");
  assert.match(fresh[1]!.id, /^B\d+$/);
});

test("a rules-pass finding is labelled, and its source survives in the review's state", () => {
  const [f] = mergeRulesPass([], [mf()], { summary: "s", recommendations: [rec()] }).added;
  const finding = { ...f!, id: "B1" };
  assert.match(inlineBody(finding), /_From the rules pass: breaks `no-raw-sql` \(rerail\)\._/);
  assert.match(inlineBody({ ...p1(), alsoBreaks: [{ module: "rerail", checkId: "no-raw-sql" }] }), /_The rules pass says this also breaks `no-raw-sql` \(rerail\)\._/);
  assert.doesNotMatch(inlineBody(p1()), /rules pass/);
  const kept = storedSource(finding);
  assert.deepEqual(kept, { src: "rules", module: "rerail", check: "no-raw-sql", fp: "fp1" });
  assert.deepEqual(storedSource(stored()), kept);
  assert.deepEqual(storedSource(p1()), {});
  assert.deepEqual(storedSource(stored({ src: undefined })), {});
});

test("the summary carries the poster's notes", () => {
  const body = summaryBody({
    verdict: "comment",
    notApprovedBecause: [],
    modelSummary: "s",
    posted: [],
    additional: [],
    nitsOverCap: 0,
    prior: [],
    escalation: { needed: false, owners: [], paths: [], noCodeowners: false },
    escalationReason: "",
    admins: [],
    ci: { state: "pass", notes: "" },
    reviewMdSuggestions: [],
    headSha: "a5a0171b",
    scope: "full review",
    runUrl: "https://example.test/run",
    handle: "@bot",
    team: "@org/reviewer",
    notes: ["**Rules pass** (1 added): ok"],
    state: { v: 1, sha: "a5a0171b", findings: [] },
  });
  assert.match(body, /\*\*Rules pass\*\* \(1 added\): ok/);
});

test("what the poster accepts from the rules pass is what schema/rules-pass.schema.json allows", async () => {
  const { Ajv } = await import("ajv");
  const schema = JSON.parse(readFileSync(new URL("../../schema/rules-pass.schema.json", import.meta.url), "utf8")) as object;
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  const dir = mkdtempSync(join(tmpdir(), "rules-schema-"));
  try {
    const path = join(dir, "out.json");
    for (const out of [
      { summary: "s", recommendations: [rec(), rec({ action: "overlap", overlapsWith: "F1" }), rec({ action: "dismiss" })] },
      { summary: "s", recommendations: [{ ...rec(), action: "rewrite" }] },
      { summary: "s", recommendations: [{ ...rec(), level: "critical" }] },
      { recommendations: [] },
    ]) {
      writeFileSync(path, JSON.stringify(out));
      assert.equal(readRulesPassOutput(path) !== undefined, validate(out), JSON.stringify(out));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
