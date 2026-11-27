// Rerail module: a headless `rerail scan` (its `rerail.scan/1` output) turned into the reviewer's module result.
// Called by run.sh after Rerail is installed. Inputs are the module contract's MODULE_* variables (docs/modules.md)
// plus RERAIL_PACKS and RERAIL_REPO_PACKS: the packs, or, set beside `.rerail/packs.json`, a replacement for its packs.
//
// Trust: rules and packs are approved only from MODULE_BASE_CHECKOUT (the base branch's tip in diff mode, the
// branch itself in repository mode), through Rerail's normal approval, and the scan reads its rules, and the packs
// `.rerail/packs.json` lists, from MODULE_BASE_SHA (--rules-ref). Nothing from the change under review is approved
// or used as config.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  /** The packs the scan ran; only from a Rerail that reads `.rerail/packs.json` (neralabs/rerail#736). */
  packs?: unknown[];
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

/** Rerail's environment with its headless-scan experiment on, and no other (neralabs/rerail#667). */
const headless = (): NodeJS.ProcessEnv => ({ ...process.env, RERAIL_EXPERIMENTAL_HEADLESS_SCAN: "1" });

/**
 * `rerail scan … --json`. Exit 0 is a completed scan whatever it found; 1 is a failed scan that may still print its
 * result. A scan with no session is experimental in Rerail and refused unless `RERAIL_EXPERIMENTAL_HEADLESS_SCAN=1`,
 * so the scan gets that; a Rerail from before the switch ignores it.
 */
export function runScan(cwd: string, args: readonly string[]): ScanResult {
  try {
    return parseScan(execFileSync(bin(), ["scan", ...args, "--json"], { cwd, env: headless(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && e.stdout?.trim()) return parseScan(e.stdout);
    throw failure(err, "rerail scan");
  }
}

function rerail(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  try {
    execFileSync(bin(), args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
 * The `path` packs the base branch's `.rerail/packs.json` lists, or undefined when it has none. Rerail reads and
 * checks the file itself (neralabs/rerail#736); the module only needs its paths, to approve those packs.
 */
export function listedRepoPacks(baseDir: string): string[] | undefined {
  const file = join(baseDir, ".rerail", "packs.json");
  if (!existsSync(file)) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`.rerail/packs.json on the base branch is not JSON: ${(err as Error).message}`);
  }
  const packs = doc !== null && typeof doc === "object" && "packs" in doc ? doc.packs : undefined;
  if (!Array.isArray(packs)) throw new Error(".rerail/packs.json on the base branch has no packs list");
  return packs.flatMap((pack: unknown) =>
    pack !== null && typeof pack === "object" && "path" in pack && typeof pack.path === "string" ? [pack.path] : [],
  );
}

/** A scan of an empty repository whose `.rerail/packs.json` lists no packs: what the installed Rerail does with it. */
function probeScan(home: string, args: readonly string[]): ScanResult {
  const dir = join(home, "packs-file-probe");
  mkdirSync(join(dir, ".rerail"), { recursive: true });
  writeFileSync(join(dir, ".rerail", "packs.json"), `${JSON.stringify({ schema: "rerail.packs/1", packs: [] })}\n`);
  git(dir, ["init", "--quiet"]);
  return runScan(dir, ["--scope", "repository", "--no-send", ...args]);
}

/**
 * Whether the installed Rerail reads `.rerail/packs.json` (neralabs/rerail#736, after 0.1.5). Its version can't tell,
 * as a build of Rerail's main still says 0.1.5, so this asks a probe scan: a Rerail that reads the file says which
 * packs it ran (`packs`), and an older one has no such field.
 */
export function readsPacksFile(home: string): boolean {
  return Array.isArray(probeScan(home, []).packs);
}

/** Why a probe scan with `args` didn't complete, or undefined when it did. */
function probeFailure(home: string, args: readonly string[]): string | undefined {
  try {
    const scan = probeScan(home, args);
    return scan.status === "completed" ? undefined : scan.failures.map((f) => f.message).join("; ") || "the scan failed";
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Throws unless the installed Rerail takes `--pack` beside `.rerail/packs.json`, in place of the packs the file lists
 * (neralabs/rerail#829). A Rerail that reads the file (#736) but predates #829 refuses `--pack` there; one that doesn't
 * read the file takes `--pack` as it always did. Asked with a probe scan, not the version.
 */
function checkPackOverride(home: string, packs: readonly string[]): void {
  const failure = probeFailure(home, packs.flatMap((p) => ["--pack", p]));
  if (failure === undefined) return;
  if (!readsPacksFile(home)) throw new Error(`a scan with --pack ${packs.join(" ")} failed: ${failure}`);
  throw new Error(
    "rerail_packs and rerail_repo_packs replace the packs the base branch's .rerail/packs.json lists, but this Rerail " +
      "refuses --pack beside that file: that needs a Rerail release with neralabs/rerail#829. Leave both inputs empty " +
      `to scan with the file's packs (rerail: ${failure})`,
  );
}

/** Adds and approves each repository pack in `repoPacks`, from the base checkout, and returns their ids. */
function addRepoPacks(baseDir: string, repoPacks: readonly string[]): string[] {
  return repoPacks.map((rel) => {
    const dir = packDirUnder(baseDir, rel);
    const id = jsonField(join(dir, "pack.json"), "id");
    rerail(baseDir, ["packs", "add", dir]);
    rerail(baseDir, ["rules", "approve", jsonField(join(dir, "package.json"), "name"), "--repo", baseDir]);
    return id;
  });
}

/**
 * With `.rerail/packs.json`: approves each `path` pack it lists, as the base checkout has it, by package name (its
 * id when it has no package.json). Nothing is added: the scan reads the packs from `--rules-ref`, and Rerail finds
 * the listed ones in `--repo`'s file only under the headless-scan experiment.
 */
function approveListedPacks(baseDir: string, paths: readonly string[]): void {
  for (const rel of paths) {
    const dir = packDirUnder(baseDir, rel);
    const name = existsSync(join(dir, "package.json")) ? jsonField(join(dir, "package.json"), "name") : jsonField(join(dir, "pack.json"), "id");
    rerail(baseDir, ["rules", "approve", name, "--repo", baseDir], headless());
  }
}

/**
 * The packs for `--pack`, approving the ones the repository keeps. Without `.rerail/packs.json` the inputs decide. With
 * it, the file decides while `rerail_packs` and `rerail_repo_packs` are both empty; either one set replaces the file's
 * packs with `--pack` (an experimental pack scan).
 */
function approvePacks(e: Env): string[] {
  const listed = listedRepoPacks(e.baseCheckout);
  if (listed === undefined) return [...e.packs, ...addRepoPacks(e.baseCheckout, e.repoPacks)];
  if (e.packs.length > 0 || e.repoPacks.length > 0) {
    console.log("Rerail module: rerail_packs and rerail_repo_packs replace the packs the base branch's .rerail/packs.json lists (--pack)");
    const packs = [...e.packs, ...addRepoPacks(e.baseCheckout, e.repoPacks)];
    checkPackOverride(e.home, packs);
    return packs;
  }
  if (readsPacksFile(e.home)) {
    console.log("Rerail module: the base branch's .rerail/packs.json decides the packs");
    approveListedPacks(e.baseCheckout, listed);
    return [];
  }
  console.log("::notice::Rerail module: the base branch has .rerail/packs.json, but this Rerail doesn't read it (that needs a release with neralabs/rerail#736), so only .rerail/rules/ runs; name packs in rerail_packs or rerail_repo_packs to run them");
  return [];
}

/**
 * The one approval step, through Rerail's normal mechanism and only for content in the base checkout: the
 * repository's packs (`approvePacks`), then each rule in `.rerail/rules/`. The scans then find those approvals by
 * content digest, so anything the change edits runs unapproved, in log. Returns the scans' `--pack` arguments: none
 * when `.rerail/packs.json` decides the packs.
 */
export function approveFromBase(e: Env): string[] {
  const packs = approvePacks(e);
  const rulesDir = join(e.baseCheckout, ".rerail", "rules");
  const ruleFiles = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith(".json")).sort() : [];
  for (const file of ruleFiles) rerail(e.baseCheckout, ["rules", "approve", jsonField(join(rulesDir, file), "id"), "--repo", e.baseCheckout]);
  return packs.flatMap((p) => ["--pack", p]);
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

/** How many violations of each level the merge base has in the files the change touches. */
export type Baseline = Record<Level, number>;

/** Every path the change touches: added, changed or deleted, and both names of a renamed file. */
function changedPaths(e: Env): string[] {
  const names = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", e.mergeBase, "HEAD"], { cwd: e.checkout, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return names.split("\u0000").filter(Boolean);
}

/**
 * The merge base scanned with the same rules, for the files the change touches that the base has: the ones it
 * changed, deleted or renamed away. Undefined when the base has none of them, so there is nothing to scan.
 */
function scanMergeBase(e: Env, head: ScanResult, rulesArgs: string[]): ScanResult | undefined {
  const baseDir = resolve(e.home, "merge-base");
  if (!existsSync(baseDir)) git(e.checkout, ["worktree", "add", "--quiet", "--detach", "--force", baseDir, e.mergeBase]);
  const touched = [...new Set([...changedPaths(e), ...head.violations.map((v) => v.path)])];
  // Only regular files the base has. A file the change added isn't there. A folder (a submodule) or a symlink is
  // not the file's own content: a link would count whatever it points at. A name with a line break is left out
  // too: the list file below has one path a line, so it would read as other paths, which the change doesn't touch.
  const paths = touched.filter((p) => !/[\u0000-\u001f]/.test(p) && lstatSync(join(baseDir, p), { throwIfNoEntry: false })?.isFile());
  if (!paths.length) return undefined;
  const listFile = join(e.home, "base-paths.txt");
  writeFileSync(listFile, `${paths.join("\n")}\n`);
  const base = runScan(baseDir, ["--scope", "repository", "--paths-from", listFile, ...rulesArgs]);
  writeFileSync(join(e.out, "raw", "base-scan.json"), `${JSON.stringify(base, null, 2)}\n`);
  if (base.status !== "completed") throw new Error("the merge-base scan failed, so new can't be told from existing");
  return base;
}

export function baselineOf(base: ScanResult | undefined): Baseline {
  const count = (level: Level) => (base?.violations ?? []).filter((v) => (LEVEL[v.mode] ?? "note") === level).length;
  return { error: count("error"), warning: count("warning"), note: count("note") };
}

/**
 * The module result for a scan, every violation marked new unless the merge base had it too. In diff mode
 * `baseline` is what the merge base had in the same files, for a check that compares the two (docs/check.md).
 */
export function toResult(scan: ScanResult, mode: Env["mode"], existing: ReadonlySet<string>, baseline?: Baseline): object {
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
    ...(mode === "diff" && baseline ? { baseline } : {}),
  };
}

/** Scans, writes raw/, sink.json and results.json. Throws on a failure, which main() records. */
export function scan(e: Env): void {
  mkdirSync(join(e.out, "raw"), { recursive: true });
  const rulesArgs = ["--rules-ref", e.baseSha, ...approveFromBase(e)];
  const scope = e.mode === "diff" ? ["--scope", "git-diff", "--base", e.mergeBase] : ["--scope", "repository"];
  const head = runScan(e.checkout, [...scope, ...rulesArgs]);
  writeFileSync(join(e.out, "raw", "scan.json"), `${JSON.stringify(head, null, 2)}\n`);
  // The results sink stores the scan as Rerail produced it.
  writeFileSync(join(e.out, "sink.json"), `${JSON.stringify([{ ...head, type: "scan", id: head.scanId }])}\n`);
  if (head.status !== "completed") throw new Error(head.failures.map((f) => f.message).join("; ") || "the scan failed");
  const base = e.mode === "diff" ? scanMergeBase(e, head, rulesArgs) : undefined;
  const existing = new Set(base?.violations.map((v) => v.fingerprint));
  const baseline = e.mode === "diff" ? baselineOf(base) : undefined;
  writeFileSync(join(e.out, "results.json"), `${JSON.stringify(toResult(head, e.mode, existing, baseline), null, 2)}\n`);
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
