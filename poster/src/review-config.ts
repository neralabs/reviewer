// The machine-readable part of a repo's REVIEW.md: a fenced block opened with
// ```json reviewer. Always read from the base branch, so a PR can't change the
// rules it is judged by. Path lists are added to the defaults; largePrLines
// replaces the caller's large_pr_lines input. There is no size limit on
// approvals; generatedPaths only keeps generated and lock files out of the
// line count for the summary-only threshold.

import { matchesAny } from "./patterns.ts";

/**
 * Pull requests opened by a dependency bot (Dependabot). With this set, such a PR is reviewed when CI finishes at its
 * head, without anyone asking, and may be approved despite the high-risk and bot-author rules when the deterministic
 * guards in dependency.ts hold.
 */
export interface DependencyUpdates {
  /** Bot logins whose PRs are dependency PRs, e.g. "dependabot[bot]". */
  authors: string[];
  /** Further bot logins allowed to add commits to those PRs (a workflow that brings pin files along). */
  pushers: string[];
  /** Paths such a PR may change freely besides manifests and lock files (CODEOWNERS syntax). */
  pinFiles: string[];
  /** Gaps in CI for these PRs, id -> description: a needs-run finding that only restates one doesn't block approval. */
  knownGaps: Record<string, string>;
}

export interface ReviewConfig {
  highRiskPaths: string[];
  generatedPaths: string[];
  /** Changed lines above which a review is summary-only. Overrides the caller's large_pr_lines when set. */
  largePrLines?: number;
  dependencyUpdates?: DependencyUpdates;
  /** Set when REVIEW.md had a config block that didn't parse. Approval is then off. */
  error?: string;
}

/** Lock files: generated, and free to change in a dependency PR. */
export const LOCK_FILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
];

export const DEFAULT_CONFIG: ReviewConfig = {
  highRiskPaths: [".github/", "REVIEW.md", "CODEOWNERS"],
  generatedPaths: [
    ...LOCK_FILES,
    "*.min.js",
    "*.min.css",
  ],
};

/**
 * Issue and pull request templates at the repo root: forms and text people fill in, which no workflow runs. The
 * built-in `.github/` entry leaves them out. A repo that wants them high-risk lists them in its REVIEW.md
 * (`.github/ISSUE_TEMPLATE/`); listing `.github/` again doesn't, since it is the built-in entry.
 */
export const TEMPLATE_PATHS = [
  "/.github/ISSUE_TEMPLATE/",
  "/.github/PULL_REQUEST_TEMPLATE/",
  "/.github/pull_request_template.md",
  "/.github/PULL_REQUEST_TEMPLATE.md",
];

/** Whether a changed path keeps a PR from approval: it matches a high-risk path, the built-in `.github/` less the templates. */
export function isHighRisk(path: string, config: ReviewConfig): boolean {
  const paths = matchesAny(path, TEMPLATE_PATHS) ? config.highRiskPaths.filter((p) => p !== ".github/") : config.highRiskPaths;
  return matchesAny(path, paths);
}

const BLOCK = /^```json reviewer[ \t]*\n([\s\S]*?)^```/m;

function stringList(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`${key} must be a list of non-empty strings`);
  }
  return value as string[];
}

const BOT_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/;

/** Only bot logins: a person listed by mistake would have their PRs reviewed and approved like a bot's. */
function botList(value: unknown, key: string): string[] {
  const list = stringList(value, key);
  const bad = list.filter((l) => !BOT_LOGIN.test(l));
  if (bad.length) throw new Error(`${key} must list bot logins ending in [bot]: ${bad.join(", ")}`);
  return list;
}

/** A JSON object with only the given keys. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, key: string, known: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${key} must be a JSON object`);
  const unknown = Object.keys(value).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`unknown keys in ${key}: ${unknown.join(", ")}`);
  return value;
}

const GAP_ID = /^[a-z0-9][a-z0-9-]*$/;

function knownGapsOf(value: unknown, key: string): Record<string, string> {
  if (!isPlainObject(value ?? {})) throw new Error(`${key} must be an object of id -> description`);
  const entries = Object.entries(value ?? {});
  const badId = entries.find(([id]) => !GAP_ID.test(id));
  if (badId) throw new Error(`${key} id ${JSON.stringify(badId[0])} must be lowercase letters, digits and dashes`);
  const badText = entries.find(([, text]) => typeof text !== "string" || !text.trim());
  if (badText) throw new Error(`${key}.${badText[0]} must be a non-empty string`);
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseDependencyUpdates(value: unknown): DependencyUpdates | undefined {
  if (value === undefined) return undefined;
  const key = "dependencyUpdates";
  const raw = object(value, key, ["authors", "pushers", "pinFiles", "knownGaps"]);
  const authors = botList(raw.authors, `${key}.authors`);
  if (!authors.length) throw new Error(`${key}.authors must name at least one bot`);
  return {
    authors,
    pushers: botList(raw.pushers, `${key}.pushers`),
    pinFiles: stringList(raw.pinFiles, `${key}.pinFiles`),
    knownGaps: knownGapsOf(raw.knownGaps, `${key}.knownGaps`),
  };
}

function positiveInteger(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${key} must be a positive integer`);
  return value as number;
}

/** Whether a PR's author is a listed dependency bot. */
export function isDependencyAuthor(login: string, config: ReviewConfig): boolean {
  return !config.error && Boolean(config.dependencyUpdates?.authors.includes(login));
}

function definedOnly<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function parseReviewConfig(reviewMd: string | undefined): ReviewConfig {
  const block = reviewMd ? BLOCK.exec(reviewMd)?.[1] : undefined;
  if (block === undefined) return { ...DEFAULT_CONFIG };
  try {
    const cfg = object(JSON.parse(block), "the block", ["highRiskPaths", "generatedPaths", "largePrLines", "dependencyUpdates"]);
    const largePrLines = positiveInteger(cfg.largePrLines, "largePrLines");
    const dependencyUpdates = parseDependencyUpdates(cfg.dependencyUpdates);
    return {
      highRiskPaths: [...DEFAULT_CONFIG.highRiskPaths, ...stringList(cfg.highRiskPaths, "highRiskPaths")],
      generatedPaths: [...DEFAULT_CONFIG.generatedPaths, ...stringList(cfg.generatedPaths, "generatedPaths")],
      ...definedOnly({ largePrLines, dependencyUpdates }),
    };
  } catch (err) {
    return { ...DEFAULT_CONFIG, error: `REVIEW.md reviewer block: ${(err as Error).message}` };
  }
}
