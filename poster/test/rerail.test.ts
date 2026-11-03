import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { loadFindings } from "../src/findings.ts";
import {
  buildBatch,
  collectRules,
  existingFingerprints,
  parseScan,
  rulesMarkdown,
  scanToFindings,
  sendBatch,
  uuidV5,
  writeRulesContext,
  type RulesSummary,
  type ScanResult,
} from "../src/rerail.ts";
import { inlineBody, type Finding } from "../src/render.ts";

const SCHEMA = new URL("../../schema/findings.schema.json", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/rerail-scan.json", import.meta.url).pathname;
const REAL = new URL("./fixtures/c3-scan-rerail.json", import.meta.url).pathname;

const load = (path: string): ScanResult => parseScan(readFileSync(path, "utf8"));
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

test("a real rerail.scan/1 result parses; anything else is refused", () => {
  const real = load(REAL);
  assert.equal(real.violations.length, 12);
  assert.ok(real.violations.every((v) => /^[0-9a-f]{32}$/.test(v.fingerprint)));
  assert.throws(() => parseScan(JSON.stringify({ schema: "rerail.scan/2", rules: [], violations: [] })), /not a rerail.scan\/1/);
  assert.throws(() => parseScan(JSON.stringify({ schema: "rerail.scan/1" })), /no rules or violations/);
});

test("violations already on the merge base are told apart from the ones the PR brings in", () => {
  const head = load(FIXTURE);
  const base = { ...head, violations: [head.violations[1]!, { ...head.violations[0]!, fingerprint: "elsewhere" }] };
  assert.deepEqual(existingFingerprints(head, base), ["fp-console-old"]);

  const md = rulesMarkdown(head, { status: "completed", baseScanned: true, existing: ["fp-console-old"] });
  const [fresh, old] = md.split("## Already on the merge base");
  assert.match(fresh!, /## New in this PR \(2\)/);
  assert.match(fresh!, /`no-raw-sql` \(block\) at `src\/db.ts:12-14`/);
  assert.match(fresh!, /`prefer-const` \(log\)/);
  assert.doesNotMatch(fresh!, /no-console-log` \(steer\) at/);
  assert.match(old!, /`no-console-log` \(steer\) at `src\/log.ts:4`/);
});

test("without a merge-base scan every violation is listed, and flagged as possibly older than the PR", () => {
  const md = rulesMarkdown(load(FIXTURE), { status: "completed", baseScanned: false, existing: [] });
  assert.match(md, /## Violations \(3; the merge base was not scanned/);
});

test("a failed scan tells the model to review without it", () => {
  const md = rulesMarkdown(undefined, { status: "failed", error: "rerail: command not found", baseScanned: false, existing: [] });
  assert.match(md, /did not complete \(rerail: command not found\)/);
  assert.match(md, /don't guess at the rules/);
});

test("the rules context lands in the bundle only when the rules job ran", () => {
  const work = tmp("rules-ctx-");
  const ctx = join(work, "context");
  mkdirSync(ctx);
  assert.equal(writeRulesContext(work, ctx), undefined);
  assert.ok(!existsSync(join(ctx, "rerail.md")));

  mkdirSync(join(work, "rules"));
  writeFileSync(join(work, "rules", "summary.json"), JSON.stringify({ status: "completed", baseScanned: true, existing: ["fp-console-old"] } satisfies RulesSummary));
  writeFileSync(join(work, "rules", "scan.json"), readFileSync(FIXTURE));
  assert.deepEqual(writeRulesContext(work, ctx), { status: "completed", violations: 3, newViolations: 2, baseScanned: true });
  assert.ok(existsSync(join(ctx, "rerail.md")));
  assert.equal(load(join(ctx, "rerail-scan.json")).scanId, load(FIXTURE).scanId);

  writeFileSync(join(work, "rules", "scan.json"), "not json");
  assert.equal(writeRulesContext(work, ctx)?.status, "failed");
  assert.match(readFileSync(join(ctx, "rerail.md"), "utf8"), /unreadable scan result/);
});

test("a scheduled scan becomes a findings document the poster's schema accepts", () => {
  for (const scan of [load(FIXTURE), load(REAL)]) {
    const doc = scanToFindings(scan);
    const path = join(tmp("scan-findings-"), "findings.json");
    writeFileSync(path, JSON.stringify(doc));
    assert.equal(loadFindings(path, SCHEMA).findings.length, scan.violations.length);
    assert.ok(doc.findings.every((f) => f.ruleId && f.title.startsWith(f.ruleId)));
  }
  const doc = scanToFindings(load(FIXTURE));
  assert.deepEqual(
    doc.findings.map((f) => [f.id, f.level, f.line, f.endLine]),
    [
      ["B1", "blocker", 12, 14],
      ["F1", "follow-up", 4, undefined],
      ["N1", "nit", 9, undefined],
    ],
  );
  assert.equal(doc.risk.level, "high");
  assert.equal(scanToFindings(load(REAL)).risk.level, "low"); // every rule in the sample runs as log
});

test("ruleId is optional, and limited to a plain identifier", () => {
  const base = { id: "B1", level: "blocker", path: "a.ts", line: 1, title: "t", evidence: "e", fix: "f", confidence: "high", needsRun: false };
  const doc = (f: object) => ({ risk: { level: "low", reasons: [] }, summary: "s", findings: [f], priorFindings: [], escalate: { needed: false, reason: "", paths: [] }, ci: { state: "pass", notes: "" } });
  const check = (f: object) => {
    const path = join(tmp("rule-id-"), "findings.json");
    writeFileSync(path, JSON.stringify(doc(f)));
    return () => loadFindings(path, SCHEMA);
  };
  assert.doesNotThrow(check(base));
  assert.doesNotThrow(check({ ...base, ruleId: "rerail-command-sigil" }));
  assert.doesNotThrow(check({ ...base, ruleId: "pack/no-raw-sql.v2" }));
  for (const ruleId of ["", "`x` @someone", "a b", "<img>", "x".repeat(200)]) assert.throws(check({ ...base, ruleId }), /ruleId/, ruleId);
});

test("a finding that breaks a rule names it", () => {
  const f: Finding = { id: "B1", level: "blocker", path: "a.ts", line: 1, title: "Raw SQL", evidence: "e", fix: "f", confidence: "high", needsRun: false, ruleId: "no-raw-sql" };
  assert.match(inlineBody(f), /Breaks Rerail rule `no-raw-sql`\./);
  assert.doesNotMatch(inlineBody({ ...f, ruleId: undefined }), /Rerail/);
});

test("uuidV5 matches the RFC 4122 test vector", () => {
  assert.equal(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
});

test("a batch is the header then the scan record, with ids stable per repository, run, attempt and scan", () => {
  const scan = load(FIXTURE);
  const ctx = { repository: "example/app", runId: "42", runAttempt: "1", kind: "pr", now: 1793750500000 };
  const { batchId, body } = buildBatch(scan, ctx);
  const lines = body.trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    type: "batch",
    protocol: 1,
    batchId,
    machineId: uuidV5("github-actions:example/app"),
    machineLabel: "github-actions:example/app",
    rerailVersion: "0.2.0",
    sentAt: 1793750500000,
  });
  assert.equal(lines[1].type, "scan");
  assert.equal(lines[1].id, scan.scanId);
  assert.equal(lines[1].violations.length, 3);
  assert.equal(buildBatch(scan, { ...ctx, now: 1 }).batchId, batchId);
  assert.notEqual(buildBatch(scan, { ...ctx, runAttempt: "2" }).batchId, batchId);
  assert.notEqual(buildBatch(scan, { ...ctx, kind: "scheduled" }).batchId, batchId);
});

function fakeFetch(statuses: (number | Error)[], accepted?: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = statuses.shift() ?? 500;
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ accepted }), { status: next });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const batch = { batchId: "b-1", body: '{"type":"batch"}\n' };
const noWait = { backoff: () => 0 };

test("send posts NDJSON with the bearer token and stops at the acknowledgement", async () => {
  const f = fakeFetch([200], "b-1");
  await sendBatch("https://sink.example/", "tok", batch, { ...noWait, fetchImpl: f.impl });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, "https://sink.example/v1/batches");
  assert.deepEqual(f.calls[0]!.init.headers, { authorization: "Bearer tok", "content-type": "application/x-ndjson" });
  assert.equal(f.calls[0]!.init.body, batch.body);
});

test("send retries server errors, rate limits and network failures, then gives up", async () => {
  const ok = fakeFetch([503, 429, new Error("ECONNRESET"), 200], "b-1");
  await sendBatch("https://sink.example", "tok", batch, { ...noWait, fetchImpl: ok.impl });
  assert.equal(ok.calls.length, 4);

  const down = fakeFetch([502, 502, 502]);
  await assert.rejects(sendBatch("https://sink.example", "tok", batch, { ...noWait, attempts: 3, fetchImpl: down.impl }), /failed after 3 attempts: HTTP 502/);
});

test("send doesn't retry a refused token, a too-large or malformed batch, or a wrong acknowledgement", async () => {
  for (const [status, message] of [
    [401, /refused the token/],
    [413, /too large/],
    [400, /rejected the batch \(400\)/],
  ] as const) {
    const f = fakeFetch([status, 200], "b-1");
    await assert.rejects(sendBatch("https://sink.example", "secret-token", batch, { ...noWait, fetchImpl: f.impl }), (err: Error) => {
      assert.match(err.message, message);
      assert.doesNotMatch(err.message, /secret-token|sink\.example/);
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
  await assert.rejects(sendBatch("https://sink.example", "t", batch, { ...noWait, fetchImpl: fakeFetch([200], "other").impl }), /acknowledged "other"/);
  await assert.rejects(sendBatch("http://sink.example", "t", batch, noWait), /must be https/);
  await assert.rejects(sendBatch("https://sink.example", "t", { batchId: "b", body: "x".repeat(5 * 1024 * 1024 + 1) }, noWait), /over 5242880 bytes/);
});

/**
 * A git repository with a main branch (as origin/main) and a PR commit on top, and a fake `rerail` that prints
 * the head fixture for a git-diff scan and, for the merge base, a result holding one of its violations.
 */
function rulesWorkspace(rerailScript: string) {
  const work = tmp("rules-job-");
  const pr = join(work, "pr");
  mkdirSync(pr);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: pr, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(pr, "src"));
  writeFileSync(join(pr, "src", "log.ts"), "console.log(1)\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(pr, "src", "db.ts"), "sql\n");
  git("add", "-A");
  git("commit", "-qm", "pr");
  writeFileSync(join(work, "gate.json"), JSON.stringify({ mode: "review", pr: 1, baseRef: "main" }));
  const bin = join(work, "rerail");
  writeFileSync(bin, `#!/usr/bin/env node\n${rerailScript}`);
  chmodSync(bin, 0o755);
  return { work, bin, mergeBase: git("rev-parse", "HEAD~1") };
}

const FAKE_RERAIL = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const head = JSON.parse(fs.readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));
const scope = args[args.indexOf("--scope") + 1];
process.stdout.write(JSON.stringify(scope === "git-diff" ? head : { ...head, scope, violations: [head.violations[1]] }));
`;

test("the rules job scans the PR with the base branch's rules, then the merge base for the same files", () => {
  const { work, bin, mergeBase } = rulesWorkspace(FAKE_RERAIL);
  const log = join(work, "calls.jsonl");
  process.env.REVIEWER_RERAIL_BIN = bin;
  process.env.FAKE_LOG = log;
  const cwd = process.cwd();
  // Relative, as in the workflow (REVIEWER_WORK=work): git once put the merge-base worktree inside pr/.
  process.chdir(dirname(work));
  try {
    const summary = collectRules(basename(work), ["example/node"]);
    assert.deepEqual(summary, { status: "completed", baseScanned: true, existing: ["fp-console-old"] });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cwd: string; args: string[] });
    const baseTip = mergeBase; // origin/main is the merge base here
    assert.deepEqual(calls[0]!.args, ["scan", "--scope", "git-diff", "--base", mergeBase, "--rules-ref", baseTip, "--pack", "example/node", "--json"]);
    assert.match(calls[1]!.cwd, /rules-base$/);
    assert.deepEqual(calls[1]!.args.slice(0, 4), ["scan", "--scope", "repository", "--paths-from"]);
    assert.deepEqual(calls[1]!.args.slice(5), ["--rules-ref", baseTip, "--pack", "example/node", "--json"]);
    // src/db.ts is new in the PR, so only src/log.ts exists on the merge base.
    assert.equal(readFileSync(calls[1]!.args[4]!, "utf8"), "src/log.ts\n");
    assert.deepEqual(JSON.parse(readFileSync(join(work, "rules", "summary.json"), "utf8")), summary);
    assert.equal(calls[1]!.cwd, realpathSync(join(work, "rules-base")));
  } finally {
    process.chdir(cwd);
    delete process.env.REVIEWER_RERAIL_BIN;
    delete process.env.FAKE_LOG;
    rmSync(work, { recursive: true, force: true });
  }
});

test("a broken rerail never fails the rules job; the summary says why", () => {
  const { work, bin } = rulesWorkspace(`process.stderr.write("engine missing"); process.exit(2);`);
  process.env.REVIEWER_RERAIL_BIN = bin;
  try {
    const summary = collectRules(work);
    assert.equal(summary.status, "failed");
    assert.match(summary.error ?? "", /exit 2.*engine missing/);
  } finally {
    delete process.env.REVIEWER_RERAIL_BIN;
    rmSync(work, { recursive: true, force: true });
  }
});
