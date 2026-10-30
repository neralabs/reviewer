// CI state at a commit: check runs plus commit statuses, leaving out this
// reviewer run's own check suite (it is always in progress while we look).

import type { GitHub, RepoRef } from "./github.ts";

export type CiState = "pass" | "fail" | "pending" | "none";

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  app: { slug: string } | null;
  check_suite: { id: number } | null;
}

interface CommitStatus {
  context: string;
  state: string;
  target_url: string | null;
}

export interface CiSnapshot {
  state: CiState;
  failed: { name: string; url: string | null; checkRunId?: number; fromActions: boolean }[];
  pending: string[];
  passed: number;
}

const FAILED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"];

export async function ownCheckSuite(gh: GitHub, repo: RepoRef): Promise<number | undefined> {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return undefined;
  const run = await gh.get<{ check_suite_id: number }>(`/repos/${repo.owner}/${repo.repo}/actions/runs/${runId}`);
  return run.check_suite_id;
}

export async function ciAt(gh: GitHub, repo: RepoRef, sha: string, excludeSuite?: number): Promise<CiSnapshot> {
  const base = `/repos/${repo.owner}/${repo.repo}/commits/${sha}`;
  const runs = (await gh.paginate<CheckRun, { check_runs: CheckRun[] }>(`${base}/check-runs`, (page) => page.check_runs)).filter(
    (r) => excludeSuite === undefined || r.check_suite?.id !== excludeSuite,
  );
  const combined = await gh.get<{ statuses: CommitStatus[] }>(`${base}/status`);

  const failed: CiSnapshot["failed"] = [];
  const pending: string[] = [];
  let passed = 0;
  for (const run of runs) {
    if (run.status !== "completed") pending.push(run.name);
    else if (FAILED_CONCLUSIONS.includes(run.conclusion ?? "")) {
      failed.push({ name: run.name, url: run.html_url, checkRunId: run.id, fromActions: run.app?.slug === "github-actions" });
    } else passed++;
  }
  for (const status of combined.statuses) {
    if (status.state === "pending") pending.push(status.context);
    else if (status.state === "failure" || status.state === "error") failed.push({ name: status.context, url: status.target_url, fromActions: false });
    else passed++;
  }

  const state: CiState = failed.length ? "fail" : pending.length ? "pending" : passed ? "pass" : "none";
  return { state, failed, pending, passed };
}

export function describeCi(ci: CiSnapshot): string {
  if (ci.state === "none") return "no checks ran at this commit";
  const parts = [`${ci.passed} passed`];
  if (ci.failed.length) parts.push(`failed: ${ci.failed.map((f) => f.name).join(", ")}`);
  if (ci.pending.length) parts.push(`pending: ${ci.pending.join(", ")}`);
  return parts.join("; ");
}
