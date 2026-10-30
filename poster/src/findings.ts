import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { commentableLines } from "./diff.ts";
import type { Level } from "./policy.ts";
import { MAX_NITS, sortFindings, type Finding } from "./render.ts";

export interface ModelOutput {
  risk: { level: "low" | "medium" | "high"; reasons: string[] };
  summary: string;
  findings: Finding[];
  priorFindings: { id: string; status: "fixed" | "open" | "moot"; evidence: string }[];
  escalate: { needed: boolean; reason: string; paths: string[] };
  ci: { state: "pass" | "fail" | "pending"; notes: string };
  reviewMdSuggestions?: string[];
}

/** Parses and validates findings.json against the schema. The review job is the untrusted side of the contract. */
export function loadFindings(findingsPath: string, schemaPath: string): ModelOutput {
  const schema: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
  const data: unknown = JSON.parse(readFileSync(findingsPath, "utf8"));
  const validate = new Ajv({ allErrors: true, strict: true }).compile<ModelOutput>(schema as object);
  if (!validate(data)) {
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new Error(`findings.json does not match the schema: ${errors}`);
  }
  return data;
}

/** What a finding shows instead of a path that is neither a changed file nor plainly a path. */
export const INVALID_PATH = "(invalid path)";

/**
 * The model's path, if it is a changed file or made only of ordinary path
 * characters. Anything else could break out of the code span it's shown in
 * (a backtick, then a mention or a tag), so it becomes INVALID_PATH, which no
 * diff line matches: such a finding is never posted inline.
 */
export function checkPath(path: string, changed: readonly string[]): string {
  return changed.includes(path) || /^[\w.@/+-]+$/.test(path) ? path : INVALID_PATH;
}

/**
 * The model reads the head under pr/ and sometimes cites that path. Strip the
 * prefix when the stripped path is a changed file and the cited one isn't.
 * Then check what's left (checkPath).
 */
export function normalizePaths(findings: readonly Finding[], changed: readonly string[]): Finding[] {
  return findings.map((f) => {
    const cited = f.path.startsWith("pr/") && !changed.includes(f.path) && changed.includes(f.path.slice(3)) ? f.path.slice(3) : f.path;
    const path = checkPath(cited, changed);
    return path === f.path ? f : { ...f, path };
  });
}

const PREFIX: Record<Level, string> = { blocker: "B", "follow-up": "F", nit: "N" };

/** Gives each new finding an id that no prior finding and no other new finding uses. */
export function renumber(findings: readonly Finding[], priorIds: readonly string[]): Finding[] {
  const taken = new Set(priorIds);
  const counters: Record<string, number> = {};
  for (const id of priorIds) {
    const m = /^([A-Z])(\d+)$/.exec(id);
    if (m) counters[m[1]!] = Math.max(counters[m[1]!] ?? 0, Number(m[2]));
  }
  return findings.map((f) => {
    if (new RegExp(`^${PREFIX[f.level]}\\d+$`).test(f.id) && !taken.has(f.id)) {
      taken.add(f.id);
      return f;
    }
    const prefix = PREFIX[f.level];
    let n = (counters[prefix] ?? 0) + 1;
    while (taken.has(`${prefix}${n}`)) n++;
    counters[prefix] = n;
    taken.add(`${prefix}${n}`);
    return { ...f, id: `${prefix}${n}` };
  });
}

export interface Placement {
  inline: Finding[];
  additional: Finding[];
  nitsOverCap: number;
}

/** Inline when GitHub accepts a comment on that head line; otherwise the summary's additional findings. Nits beyond the cap are only counted. */
export function place(findings: readonly Finding[], files: readonly { filename: string; patch?: string }[]): Placement {
  const lines = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]));
  const sorted = sortFindings(findings);
  const nits = sorted.filter((f) => f.level === "nit");
  const kept = [...sorted.filter((f) => f.level !== "nit"), ...nits.slice(0, MAX_NITS)];
  const inline: Finding[] = [];
  const additional: Finding[] = [];
  for (const f of kept) {
    const commentable = lines.get(f.path);
    if (commentable?.has(f.line)) {
      const end = f.endLine ?? f.line;
      const rangeOk = end > f.line && Array.from({ length: end - f.line + 1 }, (_, i) => f.line + i).every((l) => commentable.has(l));
      inline.push(rangeOk ? f : { ...f, endLine: undefined });
    } else {
      additional.push(f);
    }
  }
  return { inline, additional, nitsOverCap: Math.max(0, nits.length - MAX_NITS) };
}

export function reviewComment(f: Finding, body: string): Record<string, unknown> {
  return f.endLine && f.endLine > f.line
    ? { path: f.path, start_line: f.line, start_side: "RIGHT", line: f.endLine, side: "RIGHT", body }
    : { path: f.path, line: f.line, side: "RIGHT", body };
}
