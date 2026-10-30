import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INVALID_PATH, loadFindings, normalizePaths, place, renumber } from "../src/findings.ts";
import type { Finding } from "../src/render.ts";

const SCHEMA = new URL("../../schema/findings.schema.json", import.meta.url).pathname;

function finding(over: Partial<Finding>): Finding {
  return { id: "B1", level: "blocker", path: "src/a.ts", line: 2, title: "t", evidence: "e", fix: "f", confidence: "high", needsRun: false, ...over };
}

const valid = {
  risk: { level: "low", reasons: [] },
  summary: "s",
  findings: [finding({})],
  priorFindings: [],
  escalate: { needed: false, reason: "", paths: [] },
  ci: { state: "pass", notes: "" },
};

function writeJson(value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "findings-")), "findings.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("findings.json that matches the schema loads", () => {
  assert.equal(loadFindings(writeJson(valid), SCHEMA).findings.length, 1);
});

test("findings.json that breaks the contract is rejected", () => {
  const bad = [
    { ...valid, verdict: "approve" },
    { ...valid, risk: { level: "none", reasons: [] } },
    { ...valid, findings: [{ ...finding({}), level: "critical" }] },
    { ...valid, findings: [{ ...finding({}), line: 0 }] },
    { ...valid, extra: true },
    { ...valid, escalate: undefined },
  ];
  for (const value of bad) assert.throws(() => loadFindings(writeJson(value), SCHEMA), /does not match the schema/);
});

test("new findings get ids that match their level and never reuse a prior finding's id", () => {
  const out = renumber(
    [finding({ id: "B1" }), finding({ id: "B1" }), finding({ id: "N1", level: "nit" }), finding({ id: "F3", level: "nit" })],
    ["B1", "B2", "F1"],
  );
  assert.deepEqual(out.map((f) => f.id), ["B3", "B4", "N1", "N2"]);
});

test("findings on diff lines go inline; others go to the summary; nits over five are only counted", () => {
  const patch = "@@ -1,2 +1,4 @@\n a\n+b\n+c\n d";
  const nits = Array.from({ length: 7 }, (_, i) => finding({ id: `N${i + 1}`, level: "nit", line: 2 }));
  const result = place([finding({ id: "B1", line: 2, endLine: 3 }), finding({ id: "F1", level: "follow-up", line: 40 }), finding({ id: "B2", path: "other.ts" }), ...nits], [
    { filename: "src/a.ts", patch },
  ]);
  assert.deepEqual(result.inline.map((f) => f.id), ["B1", "N1", "N2", "N3", "N4", "N5"]);
  assert.equal(result.inline[0]!.endLine, 3);
  assert.deepEqual(result.additional.map((f) => f.id).sort(), ["B2", "F1"]);
  assert.equal(result.nitsOverCap, 2);
});

test("a range that leaves the hunk falls back to a single-line comment", () => {
  const result = place([finding({ line: 2, endLine: 9 })], [{ filename: "src/a.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" }]);
  assert.equal(result.inline[0]!.endLine, undefined);
});

test("paths cited under pr/ map back to the changed file", () => {
  const out = normalizePaths([finding({ path: "pr/src/a.ts" }), finding({ path: "pr/notes.md" })], ["src/a.ts", "pr/notes.md"]);
  assert.deepEqual(out.map((f) => f.path), ["src/a.ts", "pr/notes.md"]);
});

test("a path that is neither a changed file nor plainly a path is replaced and never goes inline", () => {
  const changed = ["src/a b.ts", "src/a.ts"];
  const out = normalizePaths([finding({ path: "src/a b.ts" }), finding({ path: "lib/@scope/x+y-1.ts" }), finding({ path: "` @victim <img src=x> <!--" })], changed);
  assert.deepEqual(out.map((f) => f.path), ["src/a b.ts", "lib/@scope/x+y-1.ts", INVALID_PATH]);
  assert.equal(place([out[2]!], [{ filename: "src/a.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" }]).inline.length, 0);
});
