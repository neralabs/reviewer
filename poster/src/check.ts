// The check command (check.yml's check job): each module's result becomes one GitHub check run on the commit the
// modules checked, passed or failed by the caller's rule (check-policy.ts, docs/check.md). It reads only the modules'
// checked results, never pull request content, and writes with a neralabs-reviewer token that can write checks and
// nothing else.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideCheck, parseCheckRule, type CheckOutcome } from "./check-policy.ts";
import type { Decision } from "./gate.ts";
import { GitHub, type RepoRef } from "./github.ts";
import { lastLine, readModuleResults, type ModuleFinding, type ModuleLevel } from "./modules.ts";
import { appendSummary, requireEnv, type Settings } from "./settings.ts";
import { redactSecrets } from "./text.ts";

/** GitHub takes this many annotations in one request; more go in updates, which append. */
const ANNOTATIONS_PER_REQUEST = 50;
const ANNOTATION_LEVEL: Record<ModuleLevel, "failure" | "warning" | "notice"> = { error: "failure", warning: "warning", note: "notice" };

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
}

/** A finding on its lines. The message is plain text there, so only credentials are taken out of it. */
export function annotationFor(f: ModuleFinding): Annotation {
  return {
    path: f.path,
    start_line: f.start.line,
    end_line: lastLine(f),
    annotation_level: ANNOTATION_LEVEL[f.level],
    title: f.state === "new" ? `${f.checkId} (new)` : f.checkId,
    message: redactSecrets(f.message).trim() || f.checkId,
  };
}

export interface CheckRun {
  /** The check's name: what a ruleset requires. */
  name: string;
  sha: string;
  outcome: CheckOutcome;
  detailsUrl: string;
}

/** Creates the check run, completed, and returns its page. */
export async function postCheckRun(gh: GitHub, repo: RepoRef, run: CheckRun): Promise<string> {
  const path = `/repos/${repo.owner}/${repo.repo}/check-runs`;
  const output = { title: run.outcome.title, summary: run.outcome.summary };
  const annotations = run.outcome.marked.map(annotationFor);
  const created = await gh.request<{ id: number; html_url: string }>("POST", path, {
    name: run.name,
    head_sha: run.sha,
    status: "completed",
    conclusion: run.outcome.conclusion,
    details_url: run.detailsUrl,
    output: { ...output, annotations: annotations.slice(0, ANNOTATIONS_PER_REQUEST) },
  });
  for (let i = ANNOTATIONS_PER_REQUEST; i < annotations.length; i += ANNOTATIONS_PER_REQUEST) {
    await gh.request("PATCH", `${path}/${created.id}`, { output: { ...output, annotations: annotations.slice(i, i + ANNOTATIONS_PER_REQUEST) } });
  }
  return created.html_url;
}

/**
 * The name a ruleset requires: the module's id and the base branch the change was checked against. The result
 * depends on that base (its rules, its copy of the caller, the merge base) while a check run belongs to a commit,
 * and one commit can be the head of pull requests into several branches. Without the base in the name, a pass
 * against one branch would stand for all of them.
 */
export function checkName(module: string, baseRef: string): string {
  return `${module} (${baseRef})`;
}

/**
 * One check run per module on REVIEWER_CHECK_SHA: the commit the modules job checked out, which is the pull
 * request's head at that moment. The base branch comes from the gate's decision, which the scan job wrote from the
 * event before it checked the pull request out. The job itself succeeds whatever the checks conclude.
 */
export async function checkCommand(s: Settings): Promise<void> {
  const rule = parseCheckRule(requireEnv("REVIEWER_CHECK_RULE"));
  const sha = requireEnv("REVIEWER_CHECK_SHA");
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw new Error("REVIEWER_CHECK_SHA is not a commit id");
  const { baseRef } = JSON.parse(readFileSync(join(s.work, "gate.json"), "utf8")) as Decision;
  if (!baseRef) throw new Error("the gate's decision names no base branch");
  const results = readModuleResults(s.work);
  if (!results.length) throw new Error("the modules job left no results to check: name at least one module in `modules`");
  const write = new GitHub(requireEnv("APP_TOKEN"));
  for (const result of results) {
    const outcome = decideCheck(rule, result);
    const name = checkName(result.module, baseRef);
    const url = await postCheckRun(write, s.repo, { name, sha, outcome, detailsUrl: s.runUrl });
    appendSummary(`Check \`${name.replace(/`/g, "")}\` on \`${sha.slice(0, 7)}\`: **${outcome.conclusion}**. ${outcome.title}. [Open the check](${url})`);
  }
}
