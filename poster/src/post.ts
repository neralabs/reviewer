// Posts one review per run. Reads with the caller's GITHUB_TOKEN, writes with
// the neralabs-reviewer token. Re-derives everything it can from GitHub instead of
// trusting the review job: PR state, files, CI, REVIEW.md, CODEOWNERS and the
// bot's own history.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeBotApprovals, findingThreads, latestState, listReviews, type FindingThread, type Review } from "./bot-history.ts";
import { ciAt, describeCi, ownCheckSuite } from "./ci.ts";
import type { ChangedFile } from "./diff.ts";
import { checkPath, loadFindings, normalizePaths, place, renumber, reviewComment, type ModelOutput } from "./findings.ts";
import type { Decision } from "./gate.ts";
import { fileAt, GitHub, GitHubError, type RepoRef } from "./github.ts";
import { parseCodeowners } from "./patterns.ts";
import { decideEscalation, decideVerdict } from "./policy.ts";
import type { Manifest } from "./prepare.ts";
import { parseReviewConfig } from "./review-config.ts";
import { closingReply, inlineBody, summaryBody, type Finding, type PriorStatus } from "./render.ts";
import { dismissApproval, removeTeamRequest } from "./respond.ts";
import { appendSummary, requireEnv, type Settings } from "./settings.ts";
import type { StoredFinding } from "./text.ts";

interface PullRequestDetail {
  state: string;
  user: { login: string; type: string };
  head: { sha: string };
  base: { ref: string };
  requested_teams: { slug: string }[];
}

const EVENT = { approve: "APPROVE", comment: "COMMENT", request_changes: "REQUEST_CHANGES" } as const;

function mergePrior(stored: readonly StoredFinding[], model: ModelOutput["priorFindings"]): PriorStatus[] {
  return stored.map((f) => {
    const ruled = model.find((m) => m.id === f.id);
    const status = ruled?.status ?? (f.status === "moot" ? "moot" : "open");
    const evidence = ruled?.evidence ?? (f.status === "moot" ? (f.reason ?? "ruled moot earlier") : "not re-checked in this review");
    return { id: f.id, level: f.level, title: f.title, path: f.path, line: f.line, status, evidence };
  });
}

async function codeownersAt(gh: GitHub, repo: RepoRef, ref: string): Promise<string | undefined> {
  for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const text = await fileAt(gh, repo, path, ref);
    if (text !== undefined) return text;
  }
  return undefined;
}

async function repoAdmins(gh: GitHub, repo: RepoRef): Promise<string[]> {
  try {
    const users = await gh.paginate<{ login: string; type: string }>(`/repos/${repo.owner}/${repo.repo}/collaborators?permission=admin&affiliation=direct`);
    return users.filter((u) => u.type === "User").map((u) => u.login);
  } catch (err) {
    if (err instanceof GitHubError) return [];
    throw err;
  }
}

async function closeThreads(gh: GitHub, prior: readonly PriorStatus[], threads: readonly FindingThread[], headSha: string): Promise<string[]> {
  const problems: string[] = [];
  for (const p of prior.filter((x) => x.status !== "open")) {
    const thread = threads.find((t) => t.findingId === p.id && !t.isResolved);
    if (!thread) continue;
    const body = closingReply(p, headSha);
    try {
      await gh.graphql(
        `mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { clientMutationId } }`,
        { thread: thread.threadId, body },
      );
      await gh.graphql(`mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { clientMutationId } }`, { thread: thread.threadId });
    } catch (err) {
      problems.push(`couldn't close the thread for ${p.id}: ${(err as Error).message}`);
    }
  }
  return problems;
}

async function requestOwners(gh: GitHub, repo: RepoRef, pr: number, owners: readonly string[]): Promise<string | undefined> {
  if (!owners.length) return undefined;
  const reviewers = owners.filter((o) => !o.includes("/")).map((o) => o.slice(1));
  const team_reviewers = owners.filter((o) => o.includes("/")).map((o) => o.split("/")[1]!);
  try {
    await gh.request("POST", `/repos/${repo.owner}/${repo.repo}/pulls/${pr}/requested_reviewers`, { reviewers, team_reviewers });
    return undefined;
  } catch (err) {
    return `couldn't request ${owners.join(" ")}: ${(err as Error).message}`;
  }
}

export async function post(s: Settings): Promise<void> {
  const gate = JSON.parse(readFileSync(join(s.work, "gate.json"), "utf8")) as Decision;
  const manifest = JSON.parse(readFileSync(join(s.work, "context", "manifest.json"), "utf8")) as Manifest;
  const model = loadFindings(join(s.work, "findings.json"), join(s.home, "schema", "findings.schema.json"));
  if (gate.pr !== manifest.pr) throw new Error(`gate PR #${gate.pr} and manifest PR #${manifest.pr} disagree`);

  const read = new GitHub(requireEnv("GITHUB_TOKEN"));
  const write = new GitHub(requireEnv("APP_TOKEN"));
  const { owner, repo } = s.repo;
  const prPath = `/repos/${owner}/${repo}/pulls/${manifest.pr}`;

  const pr = await read.get<PullRequestDetail>(prPath);
  if (pr.state !== "open") {
    appendSummary(`PR #${manifest.pr} is ${pr.state}; nothing posted.`);
    return;
  }
  const files = await read.paginate<ChangedFile & { patch?: string }>(`${prPath}/files`);
  const config = parseReviewConfig(await fileAt(read, s.repo, "REVIEW.md", pr.base.ref));
  const codeownersText = await codeownersAt(read, s.repo, pr.base.ref);
  const reviews: Review[] = await listReviews(read, s.repo, manifest.pr);
  const threads = await findingThreads(read, s.repo, manifest.pr, s.botLogin);
  const stored = latestState(reviews, s.botLogin)?.findings ?? [];

  const prior = mergePrior(stored, model.priorFindings);
  const changedPaths = files.map((f) => f.filename);
  const fresh: Finding[] = renumber(normalizePaths(model.findings, changedPaths), stored.map((f) => f.id));
  const placement = place(fresh, files);
  const openPrior = prior.filter((p) => p.status === "open");

  const ci = await ciAt(read, s.repo, pr.head.sha, await ownCheckSuite(read, s.repo));

  const decided = decideVerdict({
    findings: [...fresh, ...openPrior.map((p) => ({ level: p.level, path: p.path, needsRun: false }))],
    ciState: ci.state,
    changedPaths,
    config,
    isFork: Boolean(gate.isFork),
    authorIsBot: pr.user.type === "Bot",
    headCurrent: pr.head.sha === manifest.headSha,
    approvalsEnabled: s.approvalsEnabled,
    summaryOnly: manifest.summaryOnly,
  });

  const problems: string[] = [];
  const { verdict, notApprovedBecause } = decided;

  const blockerPaths = [...fresh.filter((f) => f.level === "blocker"), ...openPrior.filter((p) => p.level === "blocker")].map((f) => f.path);
  const escalation = decideEscalation({
    riskLevel: model.risk.level,
    modelNeeded: model.escalate.needed,
    modelPaths: model.escalate.paths.map((p) => checkPath(p, changedPaths)),
    blockerPaths,
    changedPaths,
    codeowners: codeownersText === undefined ? undefined : parseCodeowners(codeownersText),
    author: pr.user.login,
    reviewedHead: reviews.filter((r) => r.commit_id === manifest.headSha && r.user && r.user.login !== s.botLogin).map((r) => r.user!.login),
  });
  const admins = escalation.needed && escalation.noCodeowners ? await repoAdmins(read, s.repo) : [];
  const escalationReason =
    model.escalate.reason || (model.risk.level === "high" ? `high risk: ${model.risk.reasons.join("; ")}` : "a blocker sits on an owned path");

  const state = {
    v: 1 as const,
    sha: manifest.headSha,
    findings: [
      ...prior.filter((p) => p.status !== "fixed").map((p): StoredFinding => ({
        id: p.id,
        level: p.level,
        path: p.path,
        line: p.line,
        title: p.title,
        status: p.status === "moot" ? "moot" : "open",
        ...(p.status === "moot" ? { reason: p.evidence.slice(0, 300) } : {}),
      })),
      ...fresh.map((f): StoredFinding => ({ id: f.id, level: f.level, path: f.path, line: f.line, title: f.title.slice(0, 200), status: "open" })),
    ],
  };
  const body = (inline: Finding[], additional: Finding[]) =>
    summaryBody({
      verdict,
      notApprovedBecause,
      modelSummary: model.summary,
      posted: inline,
      additional,
      nitsOverCap: placement.nitsOverCap,
      prior,
      escalation,
      escalationReason,
      admins,
      ci: { state: ci.state, notes: describeCi(ci) },
      reviewMdSuggestions: model.reviewMdSuggestions ?? [],
      headSha: manifest.headSha,
      scope: manifest.scope,
      runUrl: s.runUrl,
      handle: s.handle,
      team: `@${owner}/${s.teamSlug}`,
      configError: config.error,
      state,
    });

  // An approval the bot gave earlier must not outlive this review.
  for (const approval of activeBotApprovals(reviews, s.botLogin)) {
    if (verdict !== "approve") await dismissApproval(write, s.repo, manifest.pr, approval.id, "Superseded by a newer review.");
  }

  const reviewsPath = `${prPath}/reviews`;
  const event = EVENT[verdict];
  try {
    await write.request("POST", reviewsPath, {
      commit_id: manifest.headSha,
      event,
      body: body(placement.inline, placement.additional),
      comments: placement.inline.map((f) => reviewComment(f, inlineBody(f))),
    });
  } catch (err) {
    // 422 means GitHub rejected an inline position; post everything in the summary instead.
    if (!(err instanceof GitHubError) || err.status !== 422) throw err;
    problems.push(`inline comments rejected (${err.body.slice(0, 200)}); all findings are in the summary`);
    await write.request("POST", reviewsPath, { commit_id: manifest.headSha, event, body: body([], [...placement.inline, ...placement.additional]) });
  }

  // The request is fulfilled; clearing it lets people request the team again for another review.
  if (pr.requested_teams.some((t) => t.slug === s.teamSlug)) {
    try {
      await removeTeamRequest(write, s.repo, manifest.pr, s.teamSlug);
    } catch (err) {
      problems.push(`couldn't remove the @${owner}/${s.teamSlug} request: ${(err as Error).message}`);
    }
  }

  problems.push(...(await closeThreads(write, prior, threads, manifest.headSha)));
  const requestProblem = await requestOwners(write, s.repo, manifest.pr, escalation.owners);
  if (requestProblem) problems.push(requestProblem);

  appendSummary(
    [
      `### Posted ${event} on #${manifest.pr}`,
      `- Scope: ${manifest.scope}`,
      `- Findings: ${placement.inline.length} inline, ${placement.additional.length} in the summary, ${placement.nitsOverCap} nits over the cap`,
      `- Earlier findings: ${prior.map((p) => `${p.id} ${p.status}`).join(", ") || "none"}`,
      `- Escalation: ${escalation.needed ? escalation.owners.join(" ") || "needed, no owner to request" : "none"}`,
      ...(notApprovedBecause.length ? [`- Not approved: ${notApprovedBecause.join("; ")}`] : []),
      ...problems.map((p) => `- Problem: ${p}`),
    ].join("\n"),
  );
}
