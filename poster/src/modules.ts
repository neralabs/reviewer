// Modules: deterministic checks that run next to the review, without a model. Each lives in modules/<id>/ with a
// run.sh. The core knows nothing about any one module: it hands each the same inputs, reads back one common result
// (schema/module-results.schema.json), and never lets a module's failure block the review. docs/modules.md has the
// contract.
//
//   work/pr/            the checkout to check: the PR head (diff mode) or the branch (repository mode)
//   work/base-tip/      the base branch's tip (diff mode): the only place a module may take config from
//   work/modules/<id>/  each module's output: results.json, optional raw/ and sink.json, its home/

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MODULE_RESULTS_SCHEMA = "reviewer.module-results/1";
export type ModuleMode = "diff" | "repository";
export type ModuleLevel = "error" | "warning" | "note";

export interface Position {
  line: number;
  column: number;
}

export interface ModuleFinding {
  module: string;
  /** The check (for Rerail, the rule) that found it. */
  checkId: string;
  level: ModuleLevel;
  path: string;
  start: Position;
  /** Exclusive. */
  end: Position;
  message: string;
  /** Stable across line moves; unique within a module's result. */
  fingerprint: string;
  /** new: the change brought it in; existing: already on the base. Always existing in repository mode. */
  state: "new" | "existing";
}

export interface ModuleResult {
  schema: typeof MODULE_RESULTS_SCHEMA;
  module: string;
  version: string;
  mode: ModuleMode;
  status: "completed" | "failed";
  error?: string;
  /** Every check the module ran, with its level: the only ids a finding may cite. */
  checks: { id: string; level: ModuleLevel }[];
  findings: ModuleFinding[];
}

const MODULE_ID = /^[a-z][a-z0-9-]{0,39}$/;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const FINGERPRINT = /^[A-Za-z0-9:_-]{1,128}$/;
const LEVELS: readonly string[] = ["error", "warning", "note"];
const MAX_MESSAGE = 2000;
const MAX_FINDINGS = 5000;

export function isModuleId(id: string): boolean {
  return MODULE_ID.test(id);
}

/** A failed result for a module that couldn't run or returned something unusable. */
export function failedResult(module: string, mode: ModuleMode, error: string): ModuleResult {
  return { schema: MODULE_RESULTS_SCHEMA, module, version: "", mode, status: "failed", error: error.slice(0, 500), checks: [], findings: [] };
}

function isPosition(p: unknown): p is Position {
  const q = p as Position;
  return typeof q === "object" && q !== null && Number.isInteger(q.line) && q.line >= 1 && Number.isInteger(q.column) && q.column >= 1;
}

/** Repository-relative, no control characters, no `..`. Display is still checked where it's posted (checkPath). */
const isPlainPath = (p: unknown) => typeof p === "string" && p !== "" && !p.startsWith("/") && !/[\u0000-\u001f]/.test(p) && !p.split("/").includes("..");

/** Each rule a finding must meet, and what to say when it doesn't. Paths, ids and fingerprints end up in posted text. */
const FINDING_RULES: [(f: ModuleFinding, module: string, checks: ReadonlySet<string>) => boolean, (f: ModuleFinding) => string][] = [
  [(f, module) => f.module === module, (f) => `names module ${JSON.stringify(f.module)}`],
  [(f, _m, checks) => checks.has(f.checkId), (f) => `cites a check the result doesn't list (${JSON.stringify(f.checkId)})`],
  [(f) => LEVELS.includes(f.level), (f) => `has level ${JSON.stringify(f.level)}`],
  [(f) => isPlainPath(f.path), (f) => `has path ${JSON.stringify(f.path)}`],
  [(f) => isPosition(f.start) && isPosition(f.end), () => "has no 1-based start and end"],
  [(f) => typeof f.fingerprint === "string" && FINGERPRINT.test(f.fingerprint), () => "has no plain fingerprint"],
  [(f) => f.state === "new" || f.state === "existing", (f) => `has state ${JSON.stringify(f.state)}`],
  [(f) => typeof f.message === "string", () => "has no message"],
];

function findingProblem(f: ModuleFinding, module: string, checks: ReadonlySet<string>): string | undefined {
  const broken = FINDING_RULES.find(([ok]) => !ok(f, module, checks));
  return broken?.[1](f);
}

function checksProblem(r: ModuleResult): string | undefined {
  if (!Array.isArray(r.checks) || !Array.isArray(r.findings)) return "no checks or findings";
  if (r.findings.length > MAX_FINDINGS) return `more than ${MAX_FINDINGS} findings`;
  const bad = r.checks.find((c) => typeof c?.id !== "string" || !CHECK_ID.test(c.id) || !LEVELS.includes(c.level));
  return bad ? `a check is not a plain id with a level (${JSON.stringify(bad).slice(0, 100)})` : undefined;
}

function headerProblem(r: ModuleResult, module: string, mode: ModuleMode): string | undefined {
  if (r?.schema !== MODULE_RESULTS_SCHEMA) return `results.json is not ${MODULE_RESULTS_SCHEMA}`;
  if (r.module !== module || r.mode !== mode) return `results.json is for ${r.module} in ${r.mode} mode`;
  return statusProblem(r);
}

function statusProblem(r: ModuleResult): string | undefined {
  if (r.status === "failed") return typeof r.error === "string" ? r.error : "the module reported a failure";
  return r.status === "completed" ? checksProblem(r) : `status ${JSON.stringify(r.status)}`;
}

function parseJson(text: string): ModuleResult | undefined {
  try {
    return JSON.parse(text) as ModuleResult;
  } catch {
    return undefined;
  }
}

/**
 * A module's results.json, checked against the contract. Anything off makes the whole result failed: a module
 * that half-works shouldn't half-steer a review.
 */
export function parseModuleResult(text: string, module: string, mode: ModuleMode): ModuleResult {
  const r = parseJson(text);
  if (!r) return failedResult(module, mode, "results.json is not JSON");
  const problem = headerProblem(r, module, mode);
  if (problem) return failedResult(module, mode, problem);
  const checks = new Set(r.checks.map((c) => c.id));
  const bad = r.findings.map((f, i) => [i, findingProblem(f, module, checks)] as const).find(([, why]) => why);
  if (bad) return failedResult(module, mode, `finding ${bad[0]} ${bad[1]}`);
  const findings = r.findings.map((f) => ({ ...f, message: f.message.slice(0, MAX_MESSAGE), state: mode === "repository" ? ("existing" as const) : f.state }));
  return { schema: MODULE_RESULTS_SCHEMA, module, version: String(r.version ?? ""), mode, status: "completed", checks: r.checks, findings };
}

/** The checkouts and shas a module gets. */
export interface ModuleTarget {
  mode: ModuleMode;
  checkout: string;
  baseCheckout: string;
  baseSha: string;
  mergeBase: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Diff mode: the PR head in work/pr and a worktree of the base branch's tip next to it. Repository mode: the
 * branch in work/pr is its own base (merged code).
 */
export function moduleTarget(work: string, mode: ModuleMode, baseRef: string | undefined): ModuleTarget {
  const checkout = resolve(work, "pr");
  const head = git(checkout, ["rev-parse", "HEAD"]);
  if (mode === "repository") return { mode, checkout, baseCheckout: checkout, baseSha: head, mergeBase: head };
  if (!baseRef) throw new Error("diff mode needs the base ref");
  const baseSha = git(checkout, ["rev-parse", `origin/${baseRef}^{commit}`]);
  const mergeBase = git(checkout, ["merge-base", baseSha, "HEAD"]);
  // Absolute: git resolves a relative worktree path against the checkout, not this process.
  const baseCheckout = resolve(work, "base-tip");
  if (!existsSync(baseCheckout)) git(checkout, ["worktree", "add", "--quiet", "--detach", "--force", baseCheckout, baseSha]);
  return { mode, checkout, baseCheckout, baseSha, mergeBase };
}

export interface RunOptions {
  /** neralabs/reviewer's checkout, which holds modules/. */
  home: string;
  work: string;
  timeoutMs?: number;
}

function execute(id: string, target: ModuleTarget, opts: RunOptions, out: string): ModuleResult {
  const script = resolve(opts.home, "modules", id, "run.sh");
  if (!existsSync(script)) return failedResult(id, target.mode, `no module ${id} in this reviewer version`);
  const home = join(out, "home");
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    MODULE_ID: id,
    MODULE_MODE: target.mode,
    MODULE_CHECKOUT: target.checkout,
    MODULE_BASE_CHECKOUT: target.baseCheckout,
    MODULE_BASE_SHA: target.baseSha,
    MODULE_MERGE_BASE: target.mergeBase,
    MODULE_HOME: home,
    MODULE_OUT: out,
    REVIEWER_HOME: resolve(opts.home),
  };
  const run = spawnSync("bash", [script], { env, cwd: target.checkout, stdio: ["ignore", "inherit", "inherit"], timeout: opts.timeoutMs ?? 15 * 60_000 });
  if (run.status !== 0) return failedResult(id, target.mode, run.error ? `run.sh: ${run.error.message}` : `run.sh exited ${run.status ?? run.signal}`);
  const resultsPath = join(out, "results.json");
  return existsSync(resultsPath) ? parseModuleResult(readFileSync(resultsPath, "utf8"), id, target.mode) : failedResult(id, target.mode, "run.sh wrote no results.json");
}

/** Runs one module's run.sh and reads back its result. Never throws. */
export function runModule(id: string, target: ModuleTarget, opts: RunOptions): ModuleResult {
  if (!isModuleId(id)) return failedResult("unknown", target.mode, `${JSON.stringify(id).slice(0, 60)} is not a module id`);
  const out = resolve(opts.work, "modules", id);
  mkdirSync(out, { recursive: true });
  const result = execute(id, target, opts, out);
  // What later jobs read: the checked result, in place of what the module wrote.
  writeFileSync(join(out, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** The modules job: every requested module, one after the other. A module that fails is recorded and the rest go on. */
export function runModules(ids: readonly string[], target: ModuleTarget, opts: RunOptions): ModuleResult[] {
  const results = [...new Set(ids)].map((id) => runModule(id, target, opts));
  mkdirSync(join(opts.work, "modules"), { recursive: true });
  // Only real module ids: each has a results.json, failed or not, for later jobs to read.
  writeFileSync(join(opts.work, "modules", "index.json"), `${JSON.stringify([...new Set(ids)].filter(isModuleId))}\n`);
  return results;
}

/** Every module result the modules job left in work/modules/, re-checked. */
export function readModuleResults(work: string): ModuleResult[] {
  const index = join(work, "modules", "index.json");
  if (!existsSync(index)) return [];
  const ids = JSON.parse(readFileSync(index, "utf8")) as string[];
  return ids.filter(isModuleId).map((id) => {
    const path = join(work, "modules", id, "results.json");
    if (!existsSync(path)) return failedResult(id, "diff", "no results.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as { mode?: ModuleMode };
    return parseModuleResult(readFileSync(path, "utf8"), id, raw.mode === "repository" ? "repository" : "diff");
  });
}

/** The last line a finding covers: `end` is exclusive, so a range ending at column 1 stops on the line before. */
export function lastLine(f: Pick<ModuleFinding, "start" | "end">): number {
  return f.end.line > f.start.line && f.end.column <= 1 ? f.end.line - 1 : Math.max(f.start.line, f.end.line);
}

export function newFindings(results: readonly ModuleResult[]): ModuleFinding[] {
  return results.flatMap((r) => (r.status === "completed" ? r.findings.filter((f) => f.state === "new") : []));
}

/** One line of the job summary per module. */
export function describeResults(results: readonly ModuleResult[]): string {
  return results
    .map((r) =>
      r.status === "completed"
        ? `- ${r.module} ${r.version}: ${r.findings.length} findings (${r.findings.filter((f) => f.state === "new").length} new) from ${r.checks.length} checks`
        : `- ${r.module}: failed (${r.error ?? "no reason"})`,
    )
    .join("\n");
}
