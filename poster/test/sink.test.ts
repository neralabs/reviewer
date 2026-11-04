import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sinkRecords } from "../src/module-commands.ts";
import { buildBatch, sendBatch, uuidV5 } from "../src/sink.ts";

const FIXTURE = new URL("../../modules/rerail/test/fixtures/rerail-scan.json", import.meta.url).pathname;
const load = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { scanId: string; violations: unknown[] };

test("uuidV5 matches the RFC 4122 test vector", () => {
  assert.equal(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
});

test("a batch is the header then the records, with ids stable per repository, run, attempt and send", () => {
  const scan = load(FIXTURE);
  const records = [{ ...scan, type: "scan", id: scan.scanId }];
  const ctx = { repository: "example/app", runId: "42", runAttempt: "1", kind: "pr", toolVersion: "0.2.0", now: 1793750500000 };
  const { batchId, body } = buildBatch(records, ctx);
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
  assert.equal(buildBatch(records, { ...ctx, now: 1 }).batchId, batchId);
  assert.notEqual(buildBatch(records, { ...ctx, runAttempt: "2" }).batchId, batchId);
  assert.notEqual(buildBatch(records, { ...ctx, kind: "scheduled" }).batchId, batchId);
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

test("the sink sends what each module handed it, and refuses anything that isn't a list of records", () => {
  const work = mkdtempSync(join(tmpdir(), "sink-"));
  try {
    const result = (module: string) => ({ schema: "reviewer.module-results/1", module, version: `${module}-1`, mode: "diff", status: "completed", checks: [], findings: [] });
    for (const m of ["quiet", "rerail"]) {
      mkdirSync(join(work, "modules", m), { recursive: true });
      writeFileSync(join(work, "modules", m, "results.json"), JSON.stringify(result(m)));
    }
    writeFileSync(join(work, "modules", "index.json"), JSON.stringify(["quiet", "rerail"]));
    writeFileSync(join(work, "modules", "rerail", "sink.json"), JSON.stringify([{ type: "scan", id: "s1", violations: [] }]));
    assert.deepEqual(sinkRecords(work), { records: [{ type: "scan", id: "s1", violations: [] }], toolVersion: "rerail-1" });
    writeFileSync(join(work, "modules", "rerail", "sink.json"), JSON.stringify([{ type: "scan" }]));
    assert.throws(() => sinkRecords(work), /rerail's sink.json is not a list of records/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
