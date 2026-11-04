// The results sink: an opt-in send of module results to a remote, as one batch of the sink protocol (NDJSON: a
// header line, then records). Generic: the records are whatever the modules handed over in their sink.json. Runs in
// the send job, which holds only the sink's URL and token.

import { createHash } from "node:crypto";


/** RFC 4122 name-based UUID, version 5 (SHA-1), in the URL namespace. */
export function uuidV5(name: string, namespace = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const bytes = createHash("sha1").update(ns).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface BatchContext {
  repository: string;
  runId: string;
  runAttempt: string;
  /** Which send in the run, so a run that sends twice sends two batches. */
  kind: string;
  /** Version of the tool that produced the records, for the header's `rerailVersion`. */
  toolVersion: string;
  now: number;
}

/** A record of the sink protocol: a `type`, a stable `id`, and its fields. */
export interface SinkRecord {
  type: string;
  id: string;
  [field: string]: unknown;
}

/**
 * One NDJSON batch: the header, then the records. The machine is the calling repository's GitHub Actions (one
 * sink token per caller repository); the batch id is stable per run, attempt and send, so a retry is stored once.
 */
export function buildBatch(records: readonly SinkRecord[], ctx: BatchContext): { batchId: string; body: string } {
  const machine = `github-actions:${ctx.repository}`;
  const batchId = uuidV5(`${machine}:${ctx.runId}:${ctx.runAttempt}:${ctx.kind}`);
  const header = { type: "batch", protocol: 1, batchId, machineId: uuidV5(machine), machineLabel: machine, rerailVersion: ctx.toolVersion, sentAt: ctx.now };
  return { batchId, body: [header, ...records].map((r) => `${JSON.stringify(r)}\n`).join("") };
}

/** The sink protocol's limit on one uncompressed batch. */
export const MAX_BATCH_BYTES = 5 * 1024 * 1024;

export interface SendOptions {
  fetchImpl?: typeof fetch;
  attempts?: number;
  /** Delay before retry n (1-based), in ms. */
  backoff?: (n: number) => number;
  timeoutMs?: number;
}

type Attempt = { done: true } | { done: false; why: string };

/** Why a status is final (no retry), or undefined for 5xx and 429, which are retried. */
function finalReason(status: number): string | undefined {
  if (status === 401) return "the remote refused the token (401)";
  if (status === 413) return "the remote says the batch is too large (413)";
  return status >= 400 && status < 500 && status !== 429 ? `the remote rejected the batch (${status})` : undefined;
}

/** What a response means: done, retry, or a final error. */
async function judge(res: Response, batchId: string): Promise<Attempt> {
  if (res.status !== 200) {
    const reason = finalReason(res.status);
    if (reason) throw new FinalError(reason);
    return { done: false, why: `HTTP ${res.status}` };
  }
  const ack = (await res.json().catch(() => ({}))) as { accepted?: string };
  if (ack.accepted !== batchId) throw new FinalError(`the remote acknowledged ${JSON.stringify(ack.accepted)}, not ${batchId}`);
  return { done: true };
}

async function attempt(endpoint: string, token: string, batch: { batchId: string; body: string }, fetchImpl: typeof fetch, timeoutMs: number): Promise<Attempt> {
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
      body: batch.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await judge(res, batch.batchId);
  } catch (err) {
    if (err instanceof FinalError) throw err;
    return { done: false, why: (err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message };
  }
}

/**
 * POSTs the batch to `<url>/v1/batches`. 200 acknowledging the batch id is success; 401, 413 and other 4xx are
 * final; 5xx, 429 and network errors are retried with backoff. Error messages never include the URL or the token.
 */
export async function sendBatch(url: string, token: string, batch: { batchId: string; body: string }, opts: SendOptions = {}): Promise<void> {
  const { fetchImpl = fetch, attempts = 5, timeoutMs = 30_000, backoff = (n: number) => Math.min(30_000, 1000 * 2 ** (n - 1)) } = opts;
  if (Buffer.byteLength(batch.body) > MAX_BATCH_BYTES) throw new Error(`batch is over ${MAX_BATCH_BYTES} bytes; not sent`);
  const endpoint = `${url.replace(/\/+$/, "")}/v1/batches`;
  if (!endpoint.startsWith("https://")) throw new Error("the remote URL must be https");
  let last = "";
  for (let n = 1; n <= attempts; n++) {
    const result = await attempt(endpoint, token, batch, fetchImpl, timeoutMs);
    if (result.done) return;
    last = result.why;
    if (n < attempts) await new Promise((r) => setTimeout(r, backoff(n)));
  }
  throw new Error(`sending batch ${batch.batchId} failed after ${attempts} attempts: ${last}`);
}

class FinalError extends Error {}
