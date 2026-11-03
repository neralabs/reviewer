// Rerail rules in the review, without the model: a headless `rerail scan` of the PR against the rules on the
// base branch, a scan of a whole branch on a schedule, and an opt-in send of either result to a Rerail remote.
//
//   rules            rules job: scan the PR head (git-diff scope) and the merge base, mark each head violation
//                    new or already on the base; writes $REVIEWER_WORK/rules/{scan,base-scan,summary}.json
//   prepare          (prepare.ts) turns that into context/rerail.md and context/rerail-scan.json
//   scan-findings    scheduled scan: a C3 scan result as a findings document (findings schema plus ruleId)
//   send             posts a C3 scan result to a Rerail remote as one sink-protocol batch
//
// The scan output's shape is Rerail's `rerail.scan/1` (headless `rerail scan --json`). Nothing here holds a
// credential except `send`, which runs in its own job with only the remote's URL and token.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Decision } from "./gate.ts";
import type { Level } from "./policy.ts";
import type { Finding } from "./render.ts";

export type RuleMode = "log" | "steer" | "block";

export interface ScanRule {
  ruleId: string;
  payloadHash: string;
  mode: RuleMode;
  source: { kind: string; id?: string; packId?: string | null; ref?: string };
}

export interface ScanViolation {
  ruleId: string;
  payloadHash: string;
  mode: RuleMode;
  code: string;
  clauseId: string;
  path: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  message: string;
  fingerprint: string;
}

export interface ScanResult {
  schema: "rerail.scan/1";
  scanId: string;
  tool: { name: string; version: string };
  startedAt: number;
  finishedAt: number;
  repository: { key: string; displayName: string };
  checkout: { path: string; head: string | null; ref: string | null };
  scope: "repository" | "git-diff";
  base: null | { ref: string; mergeBase: string };
  paths: string[] | null;
  /** Where the rules came from: the Rerail home, the worktree, or a git ref (`--rules-ref`). */
  rulesSource?: { kind: "home" | "worktree" } | { kind: "ref"; ref: string };
  status: "completed" | "failed";
  rules: ScanRule[];
  violations: ScanViolation[];
  failures: { code: string; message: string; path: string | null; ruleId: string | null }[];
  summary: { violations: number; failures: number };
}

/** What the rules job hands the review job, next to scan.json. */
export interface RulesSummary {
  status: "completed" | "failed" | "off";
  /** Why the scan failed or didn't run. */
  error?: string;
  /** Whether the merge base was scanned, so `existing` means something. */
  baseScanned: boolean;
  /** Fingerprints of head violations also found on the merge base. */
  existing: string[];
}

export function parseScan(text: string): ScanResult {
  const scan = JSON.parse(text) as Partial<ScanResult>;
  if (scan.schema !== "rerail.scan/1") throw new Error(`not a rerail.scan/1 result (schema ${JSON.stringify(scan.schema)})`);
  if (!Array.isArray(scan.violations) || !Array.isArray(scan.rules)) throw new Error("scan result has no rules or violations");
  return scan as ScanResult;
}

/**
 * Runs `rerail scan --json` in `cwd`. Exit 0 is a completed scan whatever it found; 1 is a failed scan, which
 * still prints its result when it got that far. Anything else, or no JSON, throws.
 */
export function runScan(cwd: string, args: readonly string[], bin = process.env.REVIEWER_RERAIL_BIN || "rerail"): ScanResult {
  let stdout: string;
  try {
    stdout = execFileSync(bin, ["scan", ...args, "--json"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
    if (e.status === 1 && e.stdout?.trim()) return parseScan(e.stdout);
    throw new Error(`rerail scan failed (exit ${e.status ?? "?"}): ${(e.stderr || e.message).trim().slice(0, 500)}`);
  }
  return parseScan(stdout);
}

/** Fingerprints of `head` violations that the base scan also found, on the paths the head scan covered. */
export function existingFingerprints(head: ScanResult, base: ScanResult): string[] {
  const onBase = new Set(base.violations.map((v) => v.fingerprint));
  return [...new Set(head.violations.filter((v) => onBase.has(v.fingerprint)).map((v) => v.fingerprint))];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Merge-base scan with the same rules, of the files the head violations are in: which of them were already there. */
function scanBase(work: string, prDir: string, mergeBase: string, rulesArgs: string[], head: ScanResult): Pick<RulesSummary, "baseScanned" | "existing" | "error"> {
  const failed = (why: string) => ({ baseScanned: false, existing: [], error: `merge-base scan failed, so every violation counts as new: ${why}` });
  try {
    // Absolute: git resolves a relative worktree path against prDir, not this process.
    const baseDir = resolve(work, "rules-base");
    if (!existsSync(baseDir)) git(prDir, ["worktree", "add", "--quiet", "--detach", "--force", baseDir, mergeBase]);
    // A file the PR added isn't on the base; scan only what exists there.
    const paths = [...new Set(head.violations.map((v) => v.path))].filter((p) => existsSync(join(baseDir, p)));
    if (!paths.length) return { baseScanned: true, existing: [] };
    const list = join(work, "rules", "base-paths.txt");
    writeFileSync(list, `${paths.join("\n")}\n`);
    const base = runScan(baseDir, ["--scope", "repository", "--paths-from", resolve(list), ...rulesArgs]);
    writeFileSync(join(work, "rules", "base-scan.json"), `${JSON.stringify(base, null, 2)}\n`);
    return base.status === "completed" ? { baseScanned: true, existing: existingFingerprints(head, base) } : failed("status failed");
  } catch (err) {
    return failed((err as Error).message);
  }
}

function scanPr(work: string, baseRef: string, packs: readonly string[]): RulesSummary {
  const prDir = join(work, "pr");
  const baseTip = git(prDir, ["rev-parse", `origin/${baseRef}^{commit}`]);
  const mergeBase = git(prDir, ["merge-base", baseTip, "HEAD"]);
  const rulesArgs = ["--rules-ref", baseTip, ...packs.flatMap((p) => ["--pack", p])];
  const head = runScan(prDir, ["--scope", "git-diff", "--base", mergeBase, ...rulesArgs]);
  writeFileSync(join(work, "rules", "scan.json"), `${JSON.stringify(head, null, 2)}\n`);
  if (head.status !== "completed") return { status: "failed", error: head.failures.map((f) => f.message).join("; ") || "scan failed", baseScanned: false, existing: [] };
  if (!head.violations.length) return { status: "completed", baseScanned: false, existing: [] };
  return { status: "completed", ...scanBase(work, prDir, mergeBase, rulesArgs, head) };
}

/**
 * The rules job. Rules come from the base branch tip (`--rules-ref`), so a PR can't rewrite or switch off the
 * rules it is judged by. The head scan covers the PR's changes; the merge-base scan, with the same rules, tells
 * violations the PR brought in from ones already there. Never throws: a failure is recorded in summary.json.
 */
export function collectRules(work: string, packs: readonly string[] = []): RulesSummary {
  mkdirSync(join(work, "rules"), { recursive: true });
  let summary: RulesSummary;
  try {
    const gate = JSON.parse(readFileSync(join(work, "gate.json"), "utf8")) as Decision;
    if (!gate.baseRef) throw new Error("gate.json has no base ref");
    summary = scanPr(work, gate.baseRef, packs);
  } catch (err) {
    summary = { status: "failed", error: (err as Error).message.slice(0, 500), baseScanned: false, existing: [] };
  }
  writeFileSync(join(work, "rules", "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const MAX_LISTED_VIOLATIONS = 200;

/** One violation as a Markdown list item. Messages come from rule documents on the base branch; still data. */
function violationLine(v: ScanViolation): string {
  const end = v.end.line !== v.start.line ? `-${v.end.line}` : "";
  return `- \`${v.ruleId}\` (${v.mode}) at \`${v.path}:${v.start.line}${end}\`: ${v.message.replace(/\s*\n\s*/g, " ")}`;
}

function listed(items: readonly ScanViolation[]): string[] {
  const shown = items.slice(0, MAX_LISTED_VIOLATIONS).map(violationLine);
  if (items.length > shown.length) shown.push(`- … and ${items.length - shown.length} more in context/rerail-scan.json`);
  return shown;
}

function violationSections(scan: ScanResult, summary: RulesSummary): string[] {
  if (!scan.violations.length) return ["No violations in the changed files.", ""];
  const existing = new Set(summary.existing);
  const fresh = scan.violations.filter((v) => !existing.has(v.fingerprint));
  const old = scan.violations.filter((v) => existing.has(v.fingerprint));
  const heading = summary.baseScanned
    ? `## New in this PR (${fresh.length})`
    : `## Violations (${fresh.length}; the merge base was not scanned, so some may predate this PR)`;
  const out = [heading, "", ...(fresh.length ? listed(fresh) : ["None."]), ""];
  if (old.length) out.push(`## Already on the merge base (${old.length}; not this PR's doing, not findings)`, "", ...listed(old), "");
  return out;
}

/** context/rerail.md: what the model reads about the repository's Rerail rules for this PR. */
export function rulesMarkdown(scan: ScanResult | undefined, summary: RulesSummary): string {
  const out = ["# Rerail rules on this PR", ""];
  if (summary.status !== "completed" || !scan) {
    out.push(`The Rerail scan did not complete (${summary.error ?? summary.status}). Review without it; don't guess at the rules.`, "");
    return out.join("\n");
  }
  out.push(
    "A deterministic `rerail scan` of the changed files, with the rules from the base branch (`.rerail/rules/` and the packs the repository uses). No model was involved. Each violation names its rule, the rule's mode and the place.",
    "",
    `Rules checked: ${scan.rules.map((r) => `\`${r.ruleId}\` (${r.mode})`).join(", ") || "none"}.`,
    "",
    ...(summary.error ? [`Note: ${summary.error}.`, ""] : []),
    ...violationSections(scan, summary),
  );
  return out.join("\n");
}

const LEVEL_FOR_MODE: Record<RuleMode, Level> = { block: "blocker", steer: "follow-up", log: "nit" };
const PREFIX: Record<Level, string> = { blocker: "B", "follow-up": "F", nit: "N" };
const MAX_TITLE = 200;

export interface ScanFindingsDocument {
  risk: { level: "low" | "medium" | "high"; reasons: string[] };
  summary: string;
  findings: (Finding & { ruleId: string })[];
  priorFindings: [];
  escalate: { needed: false; reason: string; paths: string[] };
  ci: { state: "pass"; notes: string };
}

/**
 * A whole-branch scan as a findings document: the review's schema, so one consumer reads both. The level comes
 * from the rule's mode (block → blocker, steer → follow-up, log → nit); the risk from the worst one.
 */
export function scanToFindings(scan: ScanResult): ScanFindingsDocument {
  const counters: Record<string, number> = {};
  const findings = scan.violations.map((v) => {
    const level = LEVEL_FOR_MODE[v.mode] ?? "nit";
    const prefix = PREFIX[level];
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    const title = `${v.ruleId}: ${v.message.replace(/\s*\n\s*/g, " ")}`;
    return {
      id: `${prefix}${counters[prefix]}`,
      level,
      path: v.path,
      line: Math.max(1, v.start.line),
      ...(v.end.line > v.start.line ? { endLine: v.end.line } : {}),
      title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title,
      evidence: `Rerail rule ${v.ruleId} (${v.mode}, clause ${v.clauseId}, ${v.code}) matched ${v.path}:${v.start.line}:${v.start.column}-${v.end.line}:${v.end.column}. ${v.message}`,
      fix: `Bring the code in line with rule ${v.ruleId}, or change the rule if it no longer fits.`,
      confidence: "high" as const,
      needsRun: false,
      ruleId: v.ruleId,
    };
  });
  const count = (mode: RuleMode) => scan.violations.filter((v) => v.mode === mode).length;
  const level = count("block") ? "high" : count("steer") ? "medium" : "low";
  const head = scan.checkout.head ? ` at ${scan.checkout.head.slice(0, 7)}` : "";
  return {
    risk: {
      level,
      reasons: [`${count("block")} block, ${count("steer")} steer and ${count("log")} log violations`, ...(scan.status === "failed" ? ["the scan did not complete"] : [])],
    },
    summary: `Rerail scan (${scan.scope}) of ${scan.repository.displayName}${head}: ${scan.violations.length} violations of ${new Set(scan.violations.map((v) => v.ruleId)).size} of ${scan.rules.length} rules, ${scan.failures.length} failures. Status: ${scan.status}.`,
    findings,
    priorFindings: [],
    escalate: { needed: false, reason: "", paths: [] },
    ci: { state: "pass", notes: "" },
  };
}

// --- Sink protocol (one batch per scan) --------------------------------------------------------------------

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
  /** Which scan in the run, so a run that sends two scans sends two batches. */
  kind: string;
  now: number;
}

/**
 * One NDJSON batch: the header, then the scan as a `scan` record. The machine is the calling repository's
 * GitHub Actions (one remote token per caller repository); the batch id is stable per run, attempt and scan, so
 * a retry is stored once.
 */
export function buildBatch(scan: ScanResult, ctx: BatchContext): { batchId: string; body: string } {
  const machine = `github-actions:${ctx.repository}`;
  const batchId = uuidV5(`${machine}:${ctx.runId}:${ctx.runAttempt}:${ctx.kind}`);
  const header = { type: "batch", protocol: 1, batchId, machineId: uuidV5(machine), machineLabel: machine, rerailVersion: scan.tool.version, sentAt: ctx.now };
  const record = { ...scan, type: "scan", id: scan.scanId };
  return { batchId, body: `${JSON.stringify(header)}\n${JSON.stringify(record)}\n` };
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

/** The rules part of the run manifest. */
export interface RulesContext {
  status: RulesSummary["status"];
  violations: number;
  /** Violations not already on the merge base (all of them when the base wasn't scanned). */
  newViolations: number;
  baseScanned: boolean;
}

function readRules(work: string): { summary: RulesSummary; scan?: ScanResult } | undefined {
  const summaryPath = join(work, "rules", "summary.json");
  if (!existsSync(summaryPath)) return undefined;
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RulesSummary;
  if (summary.status === "off") return undefined;
  const scanPath = join(work, "rules", "scan.json");
  try {
    return { summary, scan: existsSync(scanPath) ? parseScan(readFileSync(scanPath, "utf8")) : undefined };
  } catch (err) {
    return { summary: { ...summary, status: "failed", error: `unreadable scan result: ${(err as Error).message}` } };
  }
}

/**
 * Review job: turns the rules job's output (downloaded into work/rules/) into context/rerail.md and
 * context/rerail-scan.json. Undefined when the caller didn't turn rule-aware review on.
 */
export function writeRulesContext(work: string, ctx: string): RulesContext | undefined {
  const rules = readRules(work);
  if (!rules) return undefined;
  const { summary, scan } = rules;
  writeFileSync(join(ctx, "rerail.md"), rulesMarkdown(scan, summary));
  if (!scan) return { status: "failed", violations: 0, newViolations: 0, baseScanned: false };
  writeFileSync(join(ctx, "rerail-scan.json"), `${JSON.stringify(scan, null, 2)}\n`);
  const existing = new Set(summary.existing);
  return {
    status: summary.status,
    violations: scan.violations.length,
    newViolations: scan.violations.filter((v) => !existing.has(v.fingerprint)).length,
    baseScanned: summary.baseScanned,
  };
}

/** Rows for context/README.md. */
export function rulesIndexRows(r: RulesContext | undefined): string[][] {
  if (!r) return [];
  return [
    ["context/rerail.md", `The repository's Rerail rules checked against the changes (${r.status}: ${r.newViolations} new of ${r.violations} violations)`],
    ...(r.status === "completed" ? [["context/rerail-scan.json", "The raw Rerail scan result"]] : []),
  ];
}
