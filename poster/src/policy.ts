// The verdict policy (docs/architecture.md, "Verdict and approval policy"). The model reports findings and risk; the
// verdict follows from the findings and the low-risk rules alone, so no blocker plus every rule holding means
// approve. The model's risk level only drives escalation: anything that must stop a merge is a blocker.

import { isHighRisk, type ReviewConfig } from "./review-config.ts";
import type { CiState } from "./ci.ts";
import { matchesAny, ownersOf, type OwnerRule } from "./patterns.ts";

export type Verdict = "approve" | "comment" | "request_changes";
export type Level = "blocker" | "follow-up" | "nit";

export interface PolicyFinding {
  level: Level;
  path: string;
  needsRun: boolean;
  /** A REVIEW.md dependencyUpdates.knownGaps id the finding only restates (dependency PRs). */
  knownGap?: string;
}

export interface PolicyInput {
  /** New findings plus prior findings still open. */
  findings: readonly PolicyFinding[];
  ciState: CiState;
  changedPaths: readonly string[];
  config: ReviewConfig;
  isFork: boolean;
  authorIsBot: boolean;
  /** The PR head still equals the SHA that was reviewed. */
  headCurrent: boolean;
  /** Approvals are switched on for this repo (off in phase 1). */
  approvalsEnabled: boolean;
  /** The review covered only a summary (large PR). */
  summaryOnly: boolean;
  /** Dependency PRs only (dependency.ts): lifts the high-risk and bot-author rules when every guard holds. */
  dependency?: { applies: boolean; failed: readonly string[] };
}

export interface PolicyResult {
  verdict: Verdict;
  /** Why approval was withheld; empty when the verdict is approve or a blocker decided it. */
  notApprovedBecause: string[];
}

/**
 * A needs-run finding that withholds approval. On a dependency PR the exemption admits, a follow-up or nit that only
 * restates a known CI gap from the base branch's REVIEW.md doesn't: the gap is the repo's, declared up front, and the
 * summary still lists it. Any other needs-run finding still does.
 */
function blocksAsNeedsRun(f: PolicyFinding, input: PolicyInput): boolean {
  if (!f.needsRun) return false;
  const gaps = input.config.dependencyUpdates?.knownGaps ?? {};
  const restatesGap = f.knownGap !== undefined && Object.hasOwn(gaps, f.knownGap) && f.level !== "blocker";
  return !(input.dependency?.applies && restatesGap);
}

/** A dependency PR the guards don't admit says why, beside the rules that then apply as usual. */
function exemptionRefused(dependency: PolicyInput["dependency"]): string[] {
  return dependency && !dependency.applies ? [`not exempt as a dependency update: ${dependency.failed.join("; ")}`] : [];
}

export function decideVerdict(input: PolicyInput): PolicyResult {
  const blockers = input.findings.filter((f) => f.level === "blocker").length;
  if (blockers > 0) return { verdict: "request_changes", notApprovedBecause: [] };

  const { config } = input;
  const exempt = Boolean(input.dependency?.applies);
  const checks: [boolean, string][] = [
    [input.approvalsEnabled, "approvals are off for this repo"],
    [!config.error, config.error ?? ""],
    [!input.findings.some((f) => blocksAsNeedsRun(f, input)), "a finding needs a local run to settle"],
    [input.ciState === "pass", `CI is ${input.ciState} at the head`],
    [exempt || !input.changedPaths.some((p) => isHighRisk(p, config)), "the diff touches a high-risk path"],
    [!input.isFork, "the PR comes from a fork"],
    [exempt || !input.authorIsBot, "the PR was opened by a bot"],
    [input.headCurrent, "new commits landed while reviewing"],
    [!input.summaryOnly, "the PR was too large for a full review"],
  ];
  const notApprovedBecause = [...checks.filter(([ok]) => !ok).map(([, why]) => why), ...exemptionRefused(input.dependency)];
  return { verdict: notApprovedBecause.length === 0 ? "approve" : "comment", notApprovedBecause };
}

export interface EscalationInput {
  riskLevel: "low" | "medium" | "high";
  modelNeeded: boolean;
  modelPaths: readonly string[];
  blockerPaths: readonly string[];
  changedPaths: readonly string[];
  codeowners: readonly OwnerRule[] | undefined;
  author: string;
  /** Logins (and @org/team handles) that already reviewed the current head. */
  reviewedHead: readonly string[];
}

export interface Escalation {
  needed: boolean;
  owners: string[];
  paths: string[];
  noCodeowners: boolean;
}

export function decideEscalation(input: EscalationInput): Escalation {
  const rules = input.codeowners ?? [];
  const ownedBlockerPaths = input.blockerPaths.filter((p) => ownersOf(p, rules).length > 0);
  const needed = input.riskLevel === "high" || input.modelNeeded || ownedBlockerPaths.length > 0;
  if (!needed) return { needed, owners: [], paths: [], noCodeowners: !input.codeowners };

  const named = [...input.modelPaths, ...ownedBlockerPaths];
  const paths = [...new Set(named.length ? named : input.changedPaths)];
  const skip = new Set([`@${input.author}`.toLowerCase(), ...input.reviewedHead.map((r) => `@${r.replace(/^@/, "")}`.toLowerCase())]);
  const owners = [...new Set(paths.flatMap((p) => ownersOf(p, rules)))].filter((o) => !skip.has(o.toLowerCase()));
  return { needed, owners, paths, noCodeowners: !input.codeowners };
}
