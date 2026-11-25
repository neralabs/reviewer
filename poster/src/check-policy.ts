// The check policy (docs/check.md): whether one module's result passes the caller's rule, and what its GitHub check
// run says. Pure: the check command (check.ts) reads the result and posts the outcome. Only errors and warnings
// count; a note never fails a check.

import type { ModuleFinding, ModuleLevel, ModuleResult } from "./modules.ts";
import { codeSpan, redactSecrets } from "./text.ts";

export const CHECK_RULES = ["no-new", "not-more", "zero"] as const;
export type CheckRule = (typeof CHECK_RULES)[number];

const RULE_MEANS: Record<CheckRule, string> = {
  "no-new": "the change adds no error or warning",
  "not-more": "the files the change touches have no more errors and warnings than on the merge base",
  zero: "the files the change touches have no error or warning",
};

export function parseCheckRule(text: string): CheckRule {
  const rule = CHECK_RULES.find((r) => r === text.trim());
  if (!rule) throw new Error(`unknown check rule ${JSON.stringify(text.slice(0, 40))}: use ${CHECK_RULES.join(", ")}`);
  return rule;
}

/** Findings marked on their lines, at most: ten requests' worth of annotations. The rest are only counted. */
export const MAX_MARKED = 500;
const MAX_CHECK_ROWS = 30;

export interface CheckOutcome {
  conclusion: "success" | "failure";
  /** One line, shown beside the check's name. */
  title: string;
  /** Markdown, shown on the check's page. */
  summary: string;
  /** The findings the rule is about, to mark on their lines: new ones first, then by level. */
  marked: ModuleFinding[];
}

const LEVELS: readonly ModuleLevel[] = ["error", "warning", "note"];
const RANK: Record<ModuleLevel, number> = { error: 0, warning: 1, note: 2 };

/** "2 errors, 1 warning", leaving out a level with none; undefined for no errors and no warnings. */
function tally(counted: readonly ModuleFinding[]): string | undefined {
  const parts = (["error", "warning"] as const).flatMap((level) => {
    const n = counted.filter((f) => f.level === level).length;
    return n ? [`${n} ${level}${n === 1 ? "" : "s"}`] : [];
  });
  return parts.length ? parts.join(", ") : undefined;
}

function judge(rule: CheckRule, counted: readonly ModuleFinding[], baseline: ModuleResult["baseline"]): { passed: boolean; title: string } {
  switch (rule) {
    case "no-new": {
      const added = tally(counted.filter((f) => f.state === "new"));
      return { passed: added === undefined, title: added ? `New: ${added}` : "No new errors or warnings" };
    }
    case "zero": {
      const found = tally(counted);
      return { passed: found === undefined, title: found ? `${found} in the files changed` : "No errors or warnings in the files changed" };
    }
    case "not-more": {
      if (!baseline) return { passed: false, title: "The module gave no count for the merge base, so there is nothing to compare with" };
      const before = baseline.error + baseline.warning;
      return { passed: counted.length <= before, title: `Errors and warnings in the files changed: ${counted.length} now, ${before} on the merge base` };
    }
  }
}

function countsTable(result: ModuleResult): string {
  const row = (label: string, count: (level: ModuleLevel) => number) => `| ${label} | ${LEVELS.map(count).join(" | ")} |`;
  const inState = (state: ModuleFinding["state"]) => (level: ModuleLevel) => result.findings.filter((f) => f.state === state && f.level === level).length;
  const { baseline } = result;
  return [
    "| | Errors | Warnings | Notes |",
    "| --- | --: | --: | --: |",
    row("New in this change", inState("new")),
    row("Already in the files changed", inState("existing")),
    ...(baseline ? [row("On the merge base, same files", (level) => baseline[level])] : []),
  ].join("\n");
}

/** One row per check that found something, the checks with the most new findings first. */
function checksTable(findings: readonly ModuleFinding[]): string {
  const byCheck = new Map<string, { level: ModuleLevel; fresh: number; existing: number }>();
  for (const f of findings) {
    const row = byCheck.get(f.checkId) ?? { level: f.level, fresh: 0, existing: 0 };
    byCheck.set(f.checkId, { level: row.level, fresh: row.fresh + Number(f.state === "new"), existing: row.existing + Number(f.state === "existing") });
  }
  const rows = [...byCheck].sort(([a, x], [b, y]) => y.fresh - x.fresh || RANK[x.level] - RANK[y.level] || (a < b ? -1 : 1));
  if (!rows.length) return "";
  const more = rows.length > MAX_CHECK_ROWS ? `\n\nAnd ${rows.length - MAX_CHECK_ROWS} more checks with findings.` : "";
  const lines = rows.slice(0, MAX_CHECK_ROWS).map(([id, r]) => `| ${codeSpan(id)} | ${r.level} | ${r.fresh} | ${r.existing} |`);
  return `\n\n| Check | Level | New | Already there |\n| --- | --- | --: | --: |\n${lines.join("\n")}${more}`;
}

/**
 * The findings the rule is about: under `zero` every error and warning; otherwise the new ones. New notes come too,
 * last, so that past the cap it is a note that goes unmarked and not an error that failed the check.
 */
function about(rule: CheckRule, findings: readonly ModuleFinding[]): ModuleFinding[] {
  const picked = findings.filter((f) => f.state === "new" || (rule === "zero" && f.level !== "note"));
  return picked.sort(
    (a, b) =>
      Number(a.level === "note") - Number(b.level === "note") ||
      Number(b.state === "new") - Number(a.state === "new") ||
      RANK[a.level] - RANK[b.level] ||
      (a.path === b.path ? a.start.line - b.start.line : a.path < b.path ? -1 : 1),
  );
}

/**
 * One module's result under one rule. A module that failed fails the check: a gate that passed whenever its scan
 * broke would not be one.
 */
export function decideCheck(rule: CheckRule, result: ModuleResult): CheckOutcome {
  const heading = `${codeSpan(result.module)}${result.version ? ` ${codeSpan(result.version)}` : ""}, rule ${codeSpan(rule)}: ${RULE_MEANS[rule]}.`;
  if (result.status !== "completed") {
    const why = codeSpan(redactSecrets(result.error ?? "no reason given"));
    return { conclusion: "failure", title: "The check could not run", summary: `${heading}\n\n**Failed:** the module did not complete, so the rule could not be decided: ${why}`, marked: [] };
  }
  // A whole-branch result calls everything existing; only a diff can say what a change added.
  if (result.mode !== "diff") {
    return { conclusion: "failure", title: "The check could not run", summary: `${heading}\n\n**Failed:** the module's result is for a whole branch, not for this change.`, marked: [] };
  }
  const { passed, title } = judge(rule, result.findings.filter((f) => f.level !== "note"), result.baseline);
  const all = about(rule, result.findings);
  const cut = all.length > MAX_MARKED ? `\n\nOnly the first ${MAX_MARKED} of ${all.length} findings are marked on their lines.` : "";
  const summary = `${heading}\n\n**${passed ? "Passed" : "Failed"}:** ${title}.\n\n${countsTable(result)}\n\nErrors and warnings count; notes never fail the check.${checksTable(result.findings)}${cut}`;
  return { conclusion: passed ? "success" : "failure", title, summary, marked: all.slice(0, MAX_MARKED) };
}
