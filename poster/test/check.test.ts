import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { annotationFor, checkCommand, postCheckRun } from "../src/check.ts";
import { decideCheck } from "../src/check-policy.ts";
import { GitHub } from "../src/github.ts";
import type { ModuleFinding, ModuleResult } from "../src/modules.ts";
import type { Settings } from "../src/settings.ts";

const finding = (over: Partial<ModuleFinding> = {}): ModuleFinding => ({
  module: "rerail",
  checkId: "no-console-log",
  level: "warning",
  path: "src/a.ts",
  start: { line: 3, column: 5 },
  end: { line: 3, column: 16 },
  message: "Use the logger.",
  fingerprint: "fp1",
  state: "new",
  ...over,
});

const result = (findings: ModuleFinding[], over: Partial<ModuleResult> = {}): ModuleResult => ({
  schema: "reviewer.module-results/1",
  module: "rerail",
  version: "0.1.5",
  mode: "diff",
  status: "completed",
  checks: [{ id: "no-console-log", level: "warning" }],
  findings,
  ...over,
});

interface Call {
  method: string;
  url: string;
  auth: string;
  body: { name?: string; head_sha?: string; status?: string; conclusion?: string; details_url?: string; output: { title: string; summary: string; annotations: object[] } };
}

/** A stand-in for GitHub's check-runs endpoints that records every request and answers as GitHub does. */
async function fakeGitHub(): Promise<{ url: string; calls: Call[]; server: Server }> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk: Buffer) => (text += chunk.toString()));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? "", body: JSON.parse(text) as Call["body"] });
      res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 42, html_url: "https://github.test/o/r/runs/42" }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, server };
}

const SHA = "a".repeat(40);
const repo = { owner: "o", repo: "r" };

test("a finding is marked on the lines it covers, at its level, with its check as the title", () => {
  assert.deepEqual(annotationFor(finding()), { path: "src/a.ts", start_line: 3, end_line: 3, annotation_level: "warning", title: "no-console-log (new)", message: "Use the logger." });
  // End is exclusive: a range that ends at column 1 of line 9 stops on line 8.
  const block = annotationFor(finding({ level: "error", state: "existing", start: { line: 5, column: 1 }, end: { line: 9, column: 1 } }));
  assert.deepEqual([block.start_line, block.end_line, block.annotation_level, block.title], [5, 8, "failure", "no-console-log"]);
  assert.equal(annotationFor(finding({ level: "note" })).annotation_level, "notice");
  // GitHub refuses an empty message, and a credential a rule's message quoted is not posted.
  assert.equal(annotationFor(finding({ message: "  " })).message, "no-console-log");
  assert.equal(annotationFor(finding({ message: "key sk-ant-abcdefghijklmnop found" })).message, "key [redacted] found");
});

test("the check run is created completed on the scanned commit, and annotations beyond GitHub's 50 a request follow in updates", async () => {
  const { url, calls, server } = await fakeGitHub();
  try {
    const findings = Array.from({ length: 120 }, (_, i) => finding({ fingerprint: `fp${i}`, start: { line: i + 1, column: 1 }, end: { line: i + 1, column: 9 } }));
    const outcome = decideCheck("no-new", result(findings));
    const page = await postCheckRun(new GitHub("app-token", url), repo, { name: "rerail", sha: SHA, outcome, detailsUrl: "https://github.test/o/r/actions/runs/7" });
    assert.equal(page, "https://github.test/o/r/runs/42");
    assert.deepEqual(calls.map((c) => [c.method, c.url, c.auth, c.body.output.annotations.length]), [
      ["POST", "/repos/o/r/check-runs", "Bearer app-token", 50],
      ["PATCH", "/repos/o/r/check-runs/42", "Bearer app-token", 50],
      ["PATCH", "/repos/o/r/check-runs/42", "Bearer app-token", 20],
    ]);
    const { output, ...created } = calls[0]!.body;
    assert.deepEqual(created, { name: "rerail", head_sha: SHA, status: "completed", conclusion: "failure", details_url: "https://github.test/o/r/actions/runs/7" });
    assert.equal(output.title, "New: 120 warnings");
    // Every finding is marked once, in order, and each update repeats the title and summary it would otherwise clear.
    assert.deepEqual(calls.flatMap((c) => c.body.output.annotations.map((a) => (a as { start_line: number }).start_line)), findings.map((f) => f.start.line));
    assert.ok(calls.every((c) => c.body.output.title === output.title && c.body.output.summary === output.summary));
  } finally {
    server.close();
  }
});

/** A work folder as the check job has it: the modules job's results, downloaded. */
function workWith(results: Record<string, ModuleResult>): string {
  const work = mkdtempSync(join(tmpdir(), "check-"));
  mkdirSync(join(work, "modules"));
  writeFileSync(join(work, "modules", "index.json"), JSON.stringify(Object.keys(results)));
  for (const [id, r] of Object.entries(results)) {
    mkdirSync(join(work, "modules", id));
    writeFileSync(join(work, "modules", id, "results.json"), JSON.stringify(r));
  }
  return work;
}

const settingsFor = (work: string): Settings => ({
  repo,
  repoFullName: "o/r",
  teamSlug: "reviewer",
  handle: "@example-reviewer",
  botLogin: "example-reviewer[bot]",
  approvalsEnabled: false,
  largePrLines: 50000,
  work,
  home: "reviewer",
  runUrl: "https://github.test/o/r/actions/runs/7",
});

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the check command posts one check per module, named by its id, each decided by the caller's rule", async () => {
  const { url, calls, server } = await fakeGitHub();
  const work = workWith({
    rerail: result([finding({ state: "existing" })], { baseline: { error: 0, warning: 1, note: 0 } }),
    todo: { ...result([], { module: "todo" }), status: "failed", error: "run.sh exited 3", checks: [] },
  });
  const summary = join(work, "summary.md");
  const env = { GITHUB_API_URL: url, APP_TOKEN: "app-token", REVIEWER_CHECK_SHA: SHA, GITHUB_STEP_SUMMARY: summary };
  try {
    await withEnv({ ...env, REVIEWER_CHECK_RULE: "not-more" }, () => checkCommand(settingsFor(work)));
    assert.deepEqual(calls.map((c) => [c.method, c.body.name, c.body.head_sha, c.body.conclusion]), [
      ["POST", "rerail", SHA, "success"],
      // A module that failed fails its check: the gate doesn't open because the scan broke.
      ["POST", "todo", SHA, "failure"],
    ]);
    calls.length = 0;
    await withEnv({ ...env, REVIEWER_CHECK_RULE: "zero" }, () => checkCommand(settingsFor(work)));
    assert.deepEqual(calls.map((c) => [c.body.name, c.body.conclusion]), [["rerail", "failure"], ["todo", "failure"]]);
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("the check command posts nothing when its rule, its commit or its results are missing or wrong", async () => {
  const { url, calls, server } = await fakeGitHub();
  const work = workWith({ rerail: result([]) });
  const empty = workWith({});
  const env = { GITHUB_API_URL: url, APP_TOKEN: "app-token", REVIEWER_CHECK_SHA: SHA, REVIEWER_CHECK_RULE: "no-new" };
  try {
    await assert.rejects(withEnv({ ...env, REVIEWER_CHECK_RULE: "lenient" }, () => checkCommand(settingsFor(work))), /unknown check rule/);
    await assert.rejects(withEnv({ ...env, REVIEWER_CHECK_SHA: "main" }, () => checkCommand(settingsFor(work))), /not a commit id/);
    await assert.rejects(withEnv(env, () => checkCommand(settingsFor(empty))), /no results to check/);
    assert.deepEqual(calls, []);
  } finally {
    server.close();
    for (const dir of [work, empty]) rmSync(dir, { recursive: true, force: true });
  }
});
