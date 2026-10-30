import type { Escalation, Level, Verdict } from "./policy.ts";
import { codeSpan, encodeState, findingMarker, htmlCode, sanitizeModelText, type ReviewState } from "./text.ts";

export interface Finding {
  id: string;
  level: Level;
  path: string;
  line: number;
  endLine?: number;
  title: string;
  evidence: string;
  fix: string;
  confidence: "high" | "medium";
  needsRun: boolean;
}

export interface PriorStatus {
  id: string;
  level: Level;
  title: string;
  path: string;
  line: number;
  status: "fixed" | "open" | "moot";
  evidence: string;
}

export interface SummaryInput {
  verdict: Verdict;
  notApprovedBecause: string[];
  modelSummary: string;
  posted: Finding[];
  additional: Finding[];
  /** Nits over the posting cap. */
  nitsOverCap: number;
  prior: PriorStatus[];
  escalation: Escalation;
  escalationReason: string;
  admins: string[];
  ci: { state: string; notes: string };
  reviewMdSuggestions: string[];
  headSha: string;
  scope: string;
  runUrl: string;
  handle: string;
  /** The reviewer team, e.g. "@neralabs/reviewer". Requesting it asks for a review; it stays requested while an approval stands. */
  team: string;
  configError?: string;
  state: ReviewState;
}

export const MAX_NITS = 5;

const LEVEL_ORDER: Record<Level, number> = { blocker: 0, "follow-up": 1, nit: 2 };
const VERDICT_TEXT: Record<Verdict, string> = { approve: "Approve", comment: "Comment", request_changes: "Request changes" };

export function sortFindings<T extends { level: Level; path: string; line: number }>(findings: readonly T[]): T[] {
  return [...findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.path.localeCompare(b.path) || a.line - b.line);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function tally(levels: readonly Level[]): string {
  const count = (level: Level) => levels.filter((l) => l === level).length;
  return [plural(count("blocker"), "blocker"), plural(count("follow-up"), "follow-up"), plural(count("nit"), "nit")].join(" · ");
}

function findingBlock(f: Finding): string {
  const parts = [`**[${f.level}] ${sanitizeModelText(f.title)}**`, sanitizeModelText(f.evidence), `**Fix:** ${sanitizeModelText(f.fix)}`];
  if (f.needsRun) parts.push("_needs-run: only a local run can settle this._");
  if (f.confidence === "medium") parts.push("_Confidence: medium._");
  return parts.join("\n\n");
}

export function inlineBody(f: Finding): string {
  return `${findingBlock(f)}\n\n${findingMarker(f.id)}`;
}

/** The bot's reply when it resolves a finding's thread. A moot finding's evidence is the model's (or an earlier review's) text. */
export function closingReply(p: Pick<PriorStatus, "status" | "evidence">, headSha: string): string {
  return p.status === "fixed" ? `Fixed in \`${headSha.slice(0, 7)}\`.` : `Marked moot: ${sanitizeModelText(p.evidence)}`;
}

/** `path:line`, as Markdown code; `html` for a line Markdown doesn't parse. The path may hold anything a file name can. */
function location(f: { path: string; line: number; endLine?: number }, html = false): string {
  const text = `${f.path}:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ""}`;
  return html ? htmlCode(text) : codeSpan(text);
}

export function summaryBody(s: SummaryInput): string {
  const openPrior = s.prior.filter((p) => p.status === "open");
  const allLevels = [...s.posted, ...s.additional].map((f) => f.level).concat(openPrior.map((p) => p.level));
  const out: string[] = [];

  out.push(`### Reviewer: ${VERDICT_TEXT[s.verdict]}`, "", tally(allLevels) + (s.nitsOverCap ? ` (${s.nitsOverCap} more nits not posted)` : ""), "");
  out.push(sanitizeModelText(s.modelSummary), "");

  const blockers = [...s.posted, ...s.additional].filter((f) => f.level === "blocker").map((f) => f.id);
  const openBlockers = openPrior.filter((p) => p.level === "blocker").map((p) => p.id);
  if (s.verdict === "request_changes") {
    const ids = [...openBlockers, ...blockers];
    out.push(ids.length ? `**Why:** ${ids.join(", ")} must be fixed before merge.` : "**Why:** the review asked for changes.", "");
  } else if (s.verdict === "approve") {
    out.push(
      `**Why:** no blockers, and every low-risk rule holds. Like a human approval, this one stays through later pushes; it covers \`${s.headSha.slice(0, 7)}\`. Request ${s.team} again, or comment \`${s.handle} review\`, to review new commits; \`${s.handle} stop\` withdraws it.`,
      "",
    );
  } else if (s.notApprovedBecause.length) {
    out.push(`**Why not approved:** ${s.notApprovedBecause.join("; ")}.`, "");
  }

  if (s.escalation.needed) {
    if (s.escalation.owners.length) {
      out.push(`**Escalated to** ${s.escalation.owners.join(" ")}: ${sanitizeModelText(s.escalationReason)}`, "");
    } else if (s.escalation.noCodeowners) {
      const who = s.admins.length ? s.admins.map((a) => `@${a}`).join(" ") : "the repo admins";
      out.push(`**Needs another reviewer** (${who}): ${sanitizeModelText(s.escalationReason)}`, "");
    } else {
      out.push(`**Needs another reviewer:** ${sanitizeModelText(s.escalationReason)} No code owner who hasn't already reviewed this head covers ${s.escalation.paths.map(codeSpan).join(", ")}.`, "");
    }
  }
  if (s.escalation.noCodeowners) out.push("**Follow-up:** this repo has no `CODEOWNERS`, so escalations can't reach an owner.", "");

  // Every finding in the tally is listed by level: earlier ones still open, then new ones.
  // Inline comments alone aren't enough: they sit in the diff, away from the count.
  // Lists, not a table: GitHub squeezes a table's narrow columns ("St/at/us", "fix/ed").
  // Joining lines before sanitizing: a fence the sanitizer left alone would otherwise collapse into live text.
  const oneLine = (text: string) => sanitizeModelText(text.replace(/\s*\n\s*/g, " "));
  const fresh = sortFindings([...s.posted, ...s.additional]);
  const sections: [Level, string][] = [
    ["blocker", "**Blockers** (must be fixed before merge)"],
    ["follow-up", "**Follow-ups** (safe to merge; worth a ticket)"],
    ["nit", "**Nits**"],
  ];
  for (const [level, heading] of sections) {
    const open = sortFindings(openPrior.filter((p) => p.level === level));
    const found = fresh.filter((f) => f.level === level);
    if (!open.length && !found.length) continue;
    out.push(
      heading,
      "",
      ...open.map((p) => `- ${p.id} ${sanitizeModelText(p.title)} (${location(p)}). _Still open:_ ${oneLine(p.evidence)}`),
      ...found.map((f) => `- ${f.id} ${sanitizeModelText(f.title)} (${location(f)}). _New._`),
      "",
    );
  }

  const resolved = sortFindings(s.prior.filter((p) => p.status !== "open"));
  if (resolved.length) {
    const fixed = resolved.filter((p) => p.status === "fixed").length;
    const moot = resolved.length - fixed;
    const label = [fixed && `${fixed} fixed`, moot && `${moot} no longer apply`].filter(Boolean).join(", ");
    out.push(
      `<details><summary><b>Resolved since the last review</b> (${label})</summary>`,
      "",
      ...resolved.map((p) => `- ${p.id} [${p.level}] ${sanitizeModelText(p.title)}. _${p.status === "fixed" ? "Fixed" : "No longer applies"}:_ ${oneLine(p.evidence)}`),
      "",
      "</details>",
      "",
    );
  }

  if (s.additional.length) {
    out.push("**Additional findings** (outside the diff)", "");
    for (const f of sortFindings(s.additional)) out.push(`<details><summary>${f.id} ${location(f, true)}</summary>`, "", findingBlock(f), "", "</details>", "");
  }

  out.push(`**CI:** ${s.ci.state}${s.ci.notes ? `. ${sanitizeModelText(s.ci.notes)}` : ""}`, "");
  if (s.configError) out.push(`**REVIEW.md:** ${s.configError}. Approval stays off until it parses.`, "");
  if (s.reviewMdSuggestions.length) {
    out.push("**Suggested REVIEW.md lines**", "", ...s.reviewMdSuggestions.map((l) => `- ${oneLine(l)}`), "");
  }

  out.push(`<sub>Reviewed \`${s.headSha.slice(0, 7)}\` (${s.scope}) · [run](${s.runUrl}) · \`${s.handle} help\` for commands</sub>`, "", encodeState(s.state));
  return out.join("\n");
}
