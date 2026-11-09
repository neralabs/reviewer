// Dependency PRs (REVIEW.md `dependencyUpdates`): whether one may be approved despite the high-risk and bot-author
// rules. Every guard here is computed from GitHub's data about the PR, never from model output; the verdict stays
// with policy.ts. See docs/security-model.md, "Dependency PRs".

import { matchesAny } from "./patterns.ts";
import { LOCK_FILES, type ReviewConfig } from "./review-config.ts";

export interface PrCommit {
  sha: string;
  author: { login: string } | null;
  committer: { login: string } | null;
  parents: unknown[];
  commit: { verification?: { verified: boolean } | null };
}

export interface PrFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface DependencyExemption {
  /** The PR's author is a listed dependency bot. */
  dependencyPr: boolean;
  /** Every guard holds: the high-risk and bot-author rules are lifted. */
  applies: boolean;
  /** Why it doesn't apply, for the summary. */
  failed: string[];
}

/** GitHub's own committer on commits it signs for a bot (the web-flow login). */
const GITHUB_COMMITTER = "web-flow";
/** GitHub's per-PR commit list stops at 250. */
const MAX_COMMITS = 250;

/** Manifests a dependency bot edits: allowed when only version strings change. */
const MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile", "composer.json", "requirements*.txt"];
/** Workflows and composite actions: allowed when only `uses:` pins (versions, SHAs, `# vX` comments) change. */
const WORKFLOWS = ["/.github/workflows/*.yml", "/.github/workflows/*.yaml", "/.github/actions/**/action.yml", "/.github/actions/**/action.yaml"];

/**
 * A changed line that bumps the reviewer itself: its reusable workflow, or the caller's `reviewer_ref`. A reviewer
 * bump changes the approver, so a person approves it.
 */
const REVIEWER_PIN = /reviewer\/\.github\/workflows\/review\.ya?ml@|\breviewer_ref\s*:/;

const SHA = /\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/g;
const VERSION = /\bv?\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?\b/g;

/** A line with every SHA and version number replaced, so two lines that differ only in those compare equal. */
export function versionShape(line: string): string {
  return line.replace(SHA, "<sha>").replace(VERSION, "<v>").trim();
}

function changedLines(patch: string): { removed: string[]; added: string[] } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("-")) removed.push(line.slice(1));
    else if (line.startsWith("+")) added.push(line.slice(1));
  }
  return { removed, added };
}

function sortedShapes(lines: readonly string[]): string {
  return lines.map(versionShape).sort().join("\n");
}

/** The patch changes only version strings and SHAs: the removed and added lines have the same shapes. */
export function isVersionOnly(patch: string): boolean {
  const { removed, added } = changedLines(patch);
  return removed.length === added.length && sortedShapes(removed) === sortedShapes(added);
}

function touchesReviewerPin(patch: string): boolean {
  const { removed, added } = changedLines(patch);
  return [...removed, ...added].some((l) => REVIEWER_PIN.test(l));
}

function versionedProblem(path: string, patch: string | undefined): string | undefined {
  if (patch === undefined) return `${path} has no diff to check (too large)`;
  if (touchesReviewerPin(patch)) return `${path} changes the reviewer's own pin`;
  return isVersionOnly(patch) ? undefined : `${path} changes more than version strings`;
}

/** Why a changed file keeps the exemption off, or undefined when it may change in a dependency PR. */
export function fileProblem(file: PrFile, pinFiles: readonly string[]): string | undefined {
  const path = file.filename;
  if (file.status !== "modified") return `${path} is ${file.status}, not modified`;
  if (matchesAny(path, [...LOCK_FILES, ...pinFiles])) return undefined;
  if (matchesAny(path, [...MANIFESTS, ...WORKFLOWS])) return versionedProblem(path, file.patch);
  return `${path} is not a manifest, lock file, workflow or pin file`;
}

/** The author committed it, or GitHub did and signed it (Dependabot's commits). */
function committedByAuthor(c: PrCommit, author: string): boolean {
  const committer = c.committer?.login;
  return committer === author || (committer === GITHUB_COMMITTER && c.commit.verification?.verified === true);
}

/** Why a commit keeps the exemption off: it must be a trusted bot's, committed by that bot or signed by GitHub. */
export function commitProblem(c: PrCommit, trusted: ReadonlySet<string>): string | undefined {
  const short = c.sha.slice(0, 7);
  const author = c.author?.login ?? "";
  if (c.parents.length !== 1) return `commit ${short} is a merge commit`;
  if (!trusted.has(author)) return `commit ${short} is by ${author || "an unknown author"}, not a listed bot`;
  return committedByAuthor(c, author) ? undefined : `commit ${short} was committed by ${c.committer?.login ?? "an unknown committer"}`;
}

export interface ExemptionInput {
  author: string;
  isFork: boolean;
  config: ReviewConfig;
  commits: readonly PrCommit[];
  files: readonly PrFile[];
}

/** Whether a dependency PR may be approved past the high-risk and bot-author rules. Off for every other PR. */
export function dependencyExemption(input: ExemptionInput): DependencyExemption {
  const deps = input.config.error ? undefined : input.config.dependencyUpdates;
  if (!deps?.authors.includes(input.author)) return { dependencyPr: false, applies: false, failed: [] };

  const trusted = new Set([...deps.authors, ...deps.pushers]);
  const failed = [
    ...(input.isFork ? ["the PR comes from a fork"] : []),
    ...(input.commits.length >= MAX_COMMITS ? [`the PR has ${MAX_COMMITS} or more commits`] : []),
    ...(input.commits.length === 0 ? ["the PR has no commits"] : []),
    ...input.commits.map((c) => commitProblem(c, trusted)),
    ...input.files.map((f) => fileProblem(f, deps.pinFiles)),
  ].filter((p): p is string => p !== undefined);
  return { dependencyPr: true, applies: failed.length === 0, failed };
}
