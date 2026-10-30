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
}

export interface PolicyResult {
  verdict: Verdict;
  /** Why approval was withheld; empty when the verdict is approve or a blocker decided it. */
  notApprovedBecause: string[];
}

export function decideVerdict(input: PolicyInput): PolicyResult {
  const blockers = input.findings.filter((f) => f.level === "blocker").length;
  if (blockers > 0) return { verdict: "request_changes", notApprovedBecause: [] };

  const { config } = input;
  const checks: [boolean, string][] = [
    [input.approvalsEnabled, "approvals are off for this repo"],
    [!config.error, config.error ?? ""],
    [!input.findings.some((f) => f.needsRun), "a finding needs a local run to settle"],
    [input.ciState === "pass", `CI is ${input.ciState} at the head`],
    [!input.changedPaths.some((p) => isHighRisk(p, config)), "the diff touches a high-risk path"],
    [!input.isFork, "the PR comes from a fork"],
    [!input.authorIsBot, "the PR was opened by a bot"],
    [input.headCurrent, "new commits landed while reviewing"],
    [!input.summaryOnly, "the PR was too large for a full review"],
  ];
  const notApprovedBecause = checks.filter(([ok]) => !ok).map(([, why]) => why);
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
