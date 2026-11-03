// Rerail module: a headless `rerail scan` (its `rerail.scan/1` output) turned into the reviewer's module result.
// Called by run.sh after Rerail is installed. Inputs are the module contract's MODULE_* variables (docs/modules.md)
// plus RERAIL_PACKS and RERAIL_REPO_PACKS.
//
// Trust: rules and packs are approved only from MODULE_BASE_CHECKOUT (the base branch's tip in diff mode, the
// branch itself in repository mode), through Rerail's normal approval, and the scan reads its rules from
// MODULE_BASE_SHA (--rules-ref). Nothing from the change under review is approved or used as config.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

type RuleMode = "log" | "steer" | "block";
type Level = "error" | "warning" | "note";

interface Position {
  line: number;
  column: number;
}

interface ScanViolation {
  ruleId: string;
  mode: RuleMode;
  path: string;
  start: Position;
  end: Position;
  message: string;
  fingerprint: string;
}

export interface ScanResult {
  schema: "rerail.scan/1";
  scanId: string;
  tool: { name: string; version: string };
  status: "completed" | "failed";
  rules: { ruleId: string; mode: RuleMode }[];
  violations: ScanViolation[];
  failures: { message: string }[];
}

export function parseScan(text: string): ScanResult {
  const scan = JSON.parse(text) as Partial<ScanResult>;
  if (scan.schema !== "rerail.scan/1") throw new Error(`not a rerail.scan/1 result (schema ${JSON.stringify(scan.schema)})`);
  if (!Array.isArray(scan.violations) || !Array.isArray(scan.rules)) throw new Error("scan result has no rules or violations");
  return scan as ScanResult;
}

const bin = () => process.env.RERAIL_BIN || "rerail";

function failure(err: unknown, what: string): Error {
  const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
  return new Error(`${what} failed (exit ${e.status ?? "?"}): ${(e.stderr || e.stdout || e.message).trim().slice(0, 500)}`);
}

/** `rerail scan … --json`. Exit 0 is a completed scan whatever it found; 1 is a failed scan that may still print its result. */
export function runScan(cwd: string, args: readonly string[]): ScanResult {
  try {
    return parseScan(execFileSync(bin(), ["scan", ...args, "--json"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && e.stdout?.trim()) return parseScan(e.stdout);
    throw failure(err, "rerail scan");
  }
}

function rerail(cwd: string, args: readonly string[]): void {
  try {
    execFileSync(bin(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw failure(err, `rerail ${args.slice(0, 2).join(" ")}`);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isPlainRelative(rel: string): boolean {
  return rel !== "" && !isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");
}

function isInside(root: string, dir: string): boolean {
  return dir === root || dir.startsWith(`${root}${sep}`);
}

/**
 * A repository-relative pack path, resolved inside `baseDir`. An absolute path, a `..` step, or a symlink that
 * leads out of the checkout throws: approval is only for the base branch's content.
 */
export function packDirUnder(baseDir: string, rel: string): string {
  if (!isPlainRelative(rel)) throw new Error(`pack path ${JSON.stringify(rel)} must be relative to the repository root, without ..`);
  const root = realpathSync(baseDir);
  const target = resolve(root, rel);
  if (!existsSync(target)) throw new Error(`pack path ${rel} is not on the base branch`);
  // realpath, so a symlink on the base branch can't point the approval at the change's checkout or anywhere else.
  const dir = realpathSync(target);
  if (!isInside(root, dir)) throw new Error(`pack path ${rel} leads out of the base branch's checkout`);
  if (!existsSync(join(dir, "pack.json"))) throw new Error(`pack path ${rel} has no pack.json on the base branch`);
  return dir;
}

function jsonField(path: string, field: string): string {
  const value = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value) throw new Error(`${path} has no ${field}`);
  return value;
}

/**
 * The one approval step, through Rerail's normal mechanism and only for content in `baseDir`: adds and approves
 * each repository pack, and approves each rule in `.rerail/rules/`. The scan then finds those approvals by content
 * digest, so anything the change edits runs unapproved, in log. Returns the repository packs' ids, for `--pack`.
 */
export function approveFromBase(baseDir: string, repoPacks: readonly string[]): string[] {
  const ids = repoPacks.map((rel) => {
    const dir = packDirUnder(baseDir, rel);
    const id = jsonField(join(dir, "pack.json"), "id");
    rerail(baseDir, ["packs", "add", dir]);
    rerail(baseDir, ["rules", "approve", jsonField(join(dir, "package.json"), "name"), "--repo", baseDir]);
    return id;
  });
  const rulesDir = join(baseDir, ".rerail", "rules");
  const ruleFiles = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith(".json")).sort() : [];
  for (const file of ruleFiles) rerail(baseDir, ["rules", "approve", jsonField(join(rulesDir, file), "id"), "--repo", baseDir]);
  return ids;
}

export const LEVEL: Record<RuleMode, Level> = { block: "error", steer: "warning", log: "note" };

export interface Env {
  mode: "diff" | "repository";
  checkout: string;
  baseCheckout: string;
  baseSha: string;
  mergeBase: string;
  home: string;
  out: string;
  packs: string[];
  repoPacks: string[];
}

const list = (value: string | undefined) => (value ?? "").split(/[\s,]+/).filter(Boolean);

export function envFrom(env: NodeJS.ProcessEnv): Env {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`missing ${name}`);
    return value;
  };
  return {
    mode: need("MODULE_MODE") === "repository" ? "repository" : "diff",
    checkout: need("MODULE_CHECKOUT"),
    baseCheckout: need("MODULE_BASE_CHECKOUT"),
    baseSha: need("MODULE_BASE_SHA"),
    mergeBase: need("MODULE_MERGE_BASE"),
    home: need("MODULE_HOME"),
    out: need("MODULE_OUT"),
    packs: list(env.RERAIL_PACKS),
    repoPacks: list(env.RERAIL_REPO_PACKS),
  };
}

/** Fingerprints of head violations also found on the merge base, for the files they are in. */
function existingOnBase(e: Env, head: ScanResult, rulesArgs: string[]): Set<string> {
  const baseDir = resolve(e.home, "merge-base");
  if (!existsSync(baseDir)) git(e.checkout, ["worktree", "add", "--quiet", "--detach", "--force", baseDir, e.mergeBase]);
  // A file the change added isn't on the base; scan only what exists there.
  const paths = [...new Set(head.violations.map((v) => v.path))].filter((p) => existsSync(join(baseDir, p)));
  if (!paths.length) return new Set();
  const listFile = join(e.home, "base-paths.txt");
  writeFileSync(listFile, `${paths.join("\n")}\n`);
  const base = runScan(baseDir, ["--scope", "repository", "--paths-from", listFile, ...rulesArgs]);
  writeFileSync(join(e.out, "raw", "base-scan.json"), `${JSON.stringify(base, null, 2)}\n`);
  if (base.status !== "completed") throw new Error("the merge-base scan failed, so new can't be told from existing");
  return new Set(base.violations.map((v) => v.fingerprint));
}

/** The module result for a scan, every violation marked new unless the merge base had it too. */
export function toResult(scan: ScanResult, mode: Env["mode"], existing: ReadonlySet<string>): object {
  return {
    schema: "reviewer.module-results/1",
    module: "rerail",
    version: scan.tool.version,
    mode,
    status: "completed",
    checks: scan.rules.map((r) => ({ id: r.ruleId, level: LEVEL[r.mode] ?? "note" })),
    findings: scan.violations.map((v) => ({
      module: "rerail",
      checkId: v.ruleId,
      level: LEVEL[v.mode] ?? "note",
      path: v.path,
      start: v.start,
      end: v.end,
      message: v.message,
      fingerprint: v.fingerprint,
      state: mode === "diff" && !existing.has(v.fingerprint) ? "new" : "existing",
    })),
  };
}

/** Scans, writes raw/, sink.json and results.json. Throws on a failure, which main() records. */
export function scan(e: Env): void {
  mkdirSync(join(e.out, "raw"), { recursive: true });
  const packIds = approveFromBase(e.baseCheckout, e.repoPacks);
  const rulesArgs = ["--rules-ref", e.baseSha, ...[...e.packs, ...packIds].flatMap((p) => ["--pack", p])];
  const scope = e.mode === "diff" ? ["--scope", "git-diff", "--base", e.mergeBase] : ["--scope", "repository"];
  const head = runScan(e.checkout, [...scope, ...rulesArgs]);
  writeFileSync(join(e.out, "raw", "scan.json"), `${JSON.stringify(head, null, 2)}\n`);
  // The results sink stores the scan as Rerail produced it.
  writeFileSync(join(e.out, "sink.json"), `${JSON.stringify([{ ...head, type: "scan", id: head.scanId }])}\n`);
  if (head.status !== "completed") throw new Error(head.failures.map((f) => f.message).join("; ") || "the scan failed");
  const existing = e.mode === "diff" && head.violations.length ? existingOnBase(e, head, rulesArgs) : new Set<string>();
  writeFileSync(join(e.out, "results.json"), `${JSON.stringify(toResult(head, e.mode, existing), null, 2)}\n`);
}

function main(): void {
  const out = process.env.MODULE_OUT ?? ".";
  try {
    scan(envFrom(process.env));
  } catch (err) {
    const mode = process.env.MODULE_MODE === "repository" ? "repository" : "diff";
    const result = { schema: "reviewer.module-results/1", module: "rerail", version: "", mode, status: "failed", error: (err as Error).message.slice(0, 500), checks: [], findings: [] };
    writeFileSync(join(out, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`::warning::Rerail module: ${result.error}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
