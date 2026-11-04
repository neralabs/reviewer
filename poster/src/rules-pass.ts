// The rules pass: a second, smaller model step after the review. It sees the first pass's findings and the new
// module findings, and recommends what to add (rule breaches the review missed), what overlaps a first-pass finding,
// and what is a false positive. It never sees the code, and the first pass never sees module output.
//
// Everything that matters for the verdict is decided here, not by the model: where a finding is and which check it
// cites come from the module's result (by fingerprint), levels are capped by the module's level, the first pass's
// findings are never changed or dropped, and on a re-review earlier rules-pass findings are fixed or open by
// whether their fingerprint is still found.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastLine, newFindings, type ModuleFinding, type ModuleResult } from "./modules.ts";
import type { Level } from "./policy.ts";
import type { Finding } from "./render.ts";
import { sanitizeModelText, type StoredFinding } from "./text.ts";

export interface Recommendation {
  fingerprint: string;
  action: "add" | "overlap" | "dismiss";
  overlapsWith?: string;
  level: Level;
  title: string;
  evidence: string;
  fix: string;
}

export interface RulesPassOutput {
  summary: string;
  recommendations: Recommendation[];
}

/** Module findings the rules pass reads, most severe first; the rest are still posted (see mergeRulesPass). */
const MAX_GIVEN = 150;
const SEVERITY: Record<Level, number> = { nit: 0, "follow-up": 1, blocker: 2 };
const LEVEL_ORDER = { error: 0, warning: 1, note: 2 } as const;

const key = (f: Pick<ModuleFinding, "module" | "fingerprint">) => `${f.module}:${f.fingerprint}`;

/** The highest level a module finding can reach: a note is never a blocker. */
export function capFor(f: Pick<ModuleFinding, "level">): Level {
  return f.level === "note" ? "follow-up" : "blocker";
}

function lower(a: Level, b: Level): Level {
  return SEVERITY[a] <= SEVERITY[b] ? a : b;
}

/** New module findings not already reported, as open findings, in an earlier review. */
export function findingsToRecommend(results: readonly ModuleResult[], prior: readonly StoredFinding[]): ModuleFinding[] {
  const reported = new Set(prior.filter((p) => p.src === "rules" && p.status === "open").map((p) => `${p.module}:${p.fp}`));
  return newFindings(results)
    .filter((f) => !reported.has(key(f)))
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.path.localeCompare(b.path) || a.start.line - b.start.line);
}

/**
 * Writes the rules pass's inputs into `dir/input/`, outside the first pass's working directory. Returns how many
 * module findings it was given; 0 means there is nothing to run the model on.
 */
export function prepareRulesPass(dir: string, pass1: readonly Finding[], toRecommend: readonly ModuleFinding[]): number {
  const given = toRecommend.slice(0, MAX_GIVEN);
  mkdirSync(join(dir, "input"), { recursive: true });
  const firstPass = pass1.map((f) => ({ id: f.id, level: f.level, path: f.path, line: f.line, endLine: f.endLine, title: f.title }));
  writeFileSync(join(dir, "input", "pass1-findings.json"), `${JSON.stringify(firstPass, null, 2)}\n`);
  const modules = given.map((f) => ({ ...f, lastLine: lastLine(f) }));
  writeFileSync(join(dir, "input", "module-findings.json"), `${JSON.stringify(modules, null, 2)}\n`);
  writeFileSync(
    join(dir, "input", "prompt.md"),
    `Recommend what to do with each of the ${given.length} module findings in input/module-findings.json, given the first pass's ${pass1.length} findings in input/pass1-findings.json.\n`,
  );
  return given.length;
}

export interface Merged {
  /** Findings the rules pass adds, labelled as such; ids are assigned later, with everything else. */
  added: Finding[];
  /** First-pass finding id → the checks the rules pass says it also breaks. */
  alsoBreaks: Record<string, { module: string; checkId: string }[]>;
  dismissed: { module: string; checkId: string; path: string; line: number; why: string }[];
  /** Recommendations that named no new module finding, or one twice. */
  ignored: number;
}

function asFinding(f: ModuleFinding, r: Pick<Recommendation, "level" | "title" | "evidence" | "fix">, overlaps?: string): Finding {
  const end = lastLine(f);
  return {
    id: "",
    level: lower(r.level, capFor(f)),
    path: f.path,
    line: f.start.line,
    ...(end > f.start.line ? { endLine: end } : {}),
    title: r.title,
    evidence: r.evidence,
    fix: r.fix,
    confidence: "high",
    needsRun: false,
    source: { pass: "rules", module: f.module, checkId: f.checkId, fingerprint: f.fingerprint, ...(overlaps ? { overlaps } : {}) },
  };
}

/** A module finding the rules pass left out: posted from the module's own text, so a breach is never lost. */
function unreviewed(f: ModuleFinding): Finding {
  const title = `${f.checkId}: ${f.message.replace(/\s*\n\s*/g, " ")}`;
  return asFinding(f, {
    level: capFor(f),
    title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
    evidence: `${f.module} found this at ${f.path}:${f.start.line}. ${f.message}`,
    fix: `Bring the code in line with ${f.checkId}.`,
  });
}

function applyOverlap(m: Merged, f: ModuleFinding, r: Recommendation, pass1: ReadonlyMap<string, Finding>): void {
  const target = r.overlapsWith ? pass1.get(r.overlapsWith) : undefined;
  const level = lower(r.level, capFor(f));
  // The first pass's finding stays as it is. Only a breach rated more severe than it is posted on its own.
  if (target && SEVERITY[level] <= SEVERITY[target.level]) {
    (m.alsoBreaks[target.id] ??= []).push({ module: f.module, checkId: f.checkId });
  } else {
    m.added.push(asFinding(f, r, target?.id));
  }
}

function apply(m: Merged, f: ModuleFinding, r: Recommendation, pass1: ReadonlyMap<string, Finding>): void {
  if (r.action === "dismiss") m.dismissed.push({ module: f.module, checkId: f.checkId, path: f.path, line: f.start.line, why: r.evidence });
  else if (r.action === "overlap") applyOverlap(m, f, r, pass1);
  else m.added.push(asFinding(f, r));
}

/**
 * Merges the rules pass's recommendations with the module findings it was given (`given`, by fingerprint). A
 * recommendation can only point at a given finding; one it doesn't cover is posted from the module's own text.
 */
export function mergeRulesPass(pass1: readonly Finding[], given: readonly ModuleFinding[], output: RulesPassOutput): Merged {
  const byKey = new Map(given.map((f) => [f.fingerprint, f]));
  const pass1ById = new Map(pass1.map((f) => [f.id, f]));
  const merged: Merged = { added: [], alsoBreaks: {}, dismissed: [], ignored: 0 };
  const done = new Set<string>();
  for (const r of output.recommendations) {
    const f = byKey.get(r.fingerprint);
    if (!f || done.has(r.fingerprint)) {
      merged.ignored++;
      continue;
    }
    done.add(r.fingerprint);
    apply(merged, f, r, pass1ById);
  }
  for (const f of given.filter((g) => !done.has(g.fingerprint))) merged.added.push(unreviewed(f));
  return merged;
}

/**
 * Re-review: each earlier rules-pass finding is fixed when its module ran and no longer finds it as new, open when
 * it still does, and open (not re-checked) when the module didn't run this time. No model involved.
 */
export function rulePriorRulings(prior: readonly StoredFinding[], results: readonly ModuleResult[]): { id: string; status: "fixed" | "open"; evidence: string }[] {
  const ran = new Map(results.filter((r) => r.status === "completed").map((r) => [r.module, new Set(r.findings.filter((f) => f.state === "new").map((f) => f.fingerprint))]));
  return prior
    .filter((p) => p.src === "rules" && p.status === "open")
    .map((p) => {
      const found = ran.get(p.module ?? "");
      if (!found) return { id: p.id, status: "open" as const, evidence: `not re-checked: ${p.module} didn't run in this review` };
      return found.has(p.fp ?? "") ? { id: p.id, status: "open" as const, evidence: `${p.module} still finds ${p.check}` } : { id: p.id, status: "fixed" as const, evidence: `${p.module} no longer finds ${p.check}` };
    });
}

const ACTIONS: readonly string[] = ["add", "overlap", "dismiss"];
const LEVELS: readonly string[] = ["blocker", "follow-up", "nit"];
const isText = (v: unknown) => typeof v === "string";

const RECOMMENDATION_FIELDS: [keyof Recommendation, (v: unknown) => boolean][] = [
  ["fingerprint", isText],
  ["action", (v) => ACTIONS.includes(v as string)],
  ["level", (v) => LEVELS.includes(v as string)],
  ["title", isText],
  ["evidence", isText],
  ["fix", isText],
  ["overlapsWith", (v) => v === undefined || isText(v)],
];

function isRecommendation(r: Recommendation): boolean {
  return typeof r === "object" && r !== null && RECOMMENDATION_FIELDS.every(([field, ok]) => ok(r[field]));
}

/** The rules pass's output, if it is there and has the schema's shape (schema/rules-pass.schema.json). */
export function readRulesPassOutput(path: string): RulesPassOutput | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const out = JSON.parse(readFileSync(path, "utf8")) as RulesPassOutput;
    return isText(out.summary) && Array.isArray(out.recommendations) && out.recommendations.every(isRecommendation) ? out : undefined;
  } catch {
    return undefined;
  }
}

export interface RulesPassResult extends Merged {
  rulings: ReturnType<typeof rulePriorRulings>;
  /** Plain-text lines for the review's summary; model text in them is sanitized. */
  notes: string[];
}

function moduleNotes(results: readonly ModuleResult[]): string[] {
  // The workflow passes the modules job's result: a job that failed outright left no results to read.
  const job = process.env.REVIEWER_MODULES_JOB;
  const jobNote = job === "failure" || job === "cancelled" ? ["**Modules:** the modules job didn't finish, so this review has no module results."] : [];
  return [
    ...jobNote,
    ...results
      .filter((r) => r.status === "failed")
      .map((r) => `**Modules:** ${r.module} didn't complete (${sanitizeModelText(r.error ?? "no reason given")}), so its checks aren't in this review.`),
  ];
}

function summaryNote(output: RulesPassOutput, m: Merged): string {
  const overlaps = Object.values(m.alsoBreaks).reduce((n, list) => n + list.length, 0);
  const counts = `${m.added.length} added, ${overlaps} on first-pass findings, ${m.dismissed.length} dismissed as false positives`;
  const dismissed = m.dismissed.map((d) => `${d.checkId} at ${d.path}:${d.line}`).join("; ");
  return `**Rules pass** (${counts}): ${sanitizeModelText(output.summary.replace(/\s*\n\s*/g, " "))}${dismissed ? ` Dismissed: ${sanitizeModelText(dismissed)}.` : ""}`;
}

/**
 * Everything the poster takes from the modules and the rules pass. `work/modules/` and `work/rules-pass/` come from
 * the modules and rules-pass jobs; without them this adds nothing. If the rules pass should have run and didn't
 * finish, the first pass posts alone and a note says what is missing.
 */
export function loadRulesPass(work: string, pass1: readonly Finding[], results: readonly ModuleResult[], prior: readonly StoredFinding[]): RulesPassResult {
  const rulings = rulePriorRulings(prior, results);
  const notes = moduleNotes(results);
  const empty: Merged = { added: [], alsoBreaks: {}, dismissed: [], ignored: 0 };
  const toRecommend = findingsToRecommend(results, prior);
  if (!toRecommend.length) return { ...empty, rulings, notes };
  const output = readRulesPassOutput(join(work, "rules-pass", "rules-pass.json"));
  if (!output) {
    notes.push(`**Rules pass:** didn't complete, so ${toRecommend.length} new module findings aren't in this review. The modules' results are in this run's artifacts.`);
    return { ...empty, rulings, notes };
  }
  const merged = mergeRulesPass(pass1, toRecommend.slice(0, MAX_GIVEN), output);
  // Over the cap the rules pass never saw them; they are posted from the modules' own text.
  merged.added.push(...toRecommend.slice(MAX_GIVEN).map(unreviewed));
  return { ...merged, rulings, notes: [...notes, summaryNote(output, merged)] };
}

/** First-pass findings with the checks the rules pass says they also break. */
export function annotate(pass1: readonly Finding[], alsoBreaks: Merged["alsoBreaks"]): Finding[] {
  return pass1.map((f) => (alsoBreaks[f.id] ? { ...f, alsoBreaks: alsoBreaks[f.id] } : f));
}

/** What the review's state keeps about a rules-pass finding, so a re-review can re-check it by fingerprint. */
export function storedSource(f: Pick<Finding, "source"> | Pick<StoredFinding, "src" | "module" | "check" | "fp"> | undefined): Partial<StoredFinding> {
  if (!f) return {};
  // A finding without a source has no "source" key and no src: either way it keeps nothing.
  return "source" in f ? fromFinding(f as Pick<Finding, "source">) : fromStored(f as Pick<StoredFinding, "src" | "module" | "check" | "fp">);
}

function fromFinding(f: Pick<Finding, "source">): Partial<StoredFinding> {
  return f.source ? { src: "rules", module: f.source.module, check: f.source.checkId, fp: f.source.fingerprint } : {};
}

function fromStored(f: Pick<StoredFinding, "src" | "module" | "check" | "fp">): Partial<StoredFinding> {
  return f.src === "rules" ? { src: "rules", module: f.module, check: f.check, fp: f.fp } : {};
}
