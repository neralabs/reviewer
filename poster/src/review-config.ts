// The machine-readable part of a repo's REVIEW.md: a fenced block opened with
// ```json reviewer. Always read from the base branch, so a PR can't change the
// rules it is judged by. Path lists are added to the defaults; largePrLines
// replaces the caller's large_pr_lines input. There is no size limit on
// approvals; generatedPaths only keeps generated and lock files out of the
// line count for the summary-only threshold.

import { matchesAny } from "./patterns.ts";

export interface ReviewConfig {
  highRiskPaths: string[];
  generatedPaths: string[];
  /** Changed lines above which a review is summary-only. Overrides the caller's large_pr_lines when set. */
  largePrLines?: number;
  /** Set when REVIEW.md had a config block that didn't parse. Approval is then off. */
  error?: string;
}

export const DEFAULT_CONFIG: ReviewConfig = {
  highRiskPaths: [".github/", "REVIEW.md", "CODEOWNERS"],
  generatedPaths: [
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

export function parseReviewConfig(reviewMd: string | undefined): ReviewConfig {
  const block = reviewMd ? BLOCK.exec(reviewMd)?.[1] : undefined;
  if (block === undefined) return { ...DEFAULT_CONFIG };
  try {
    const raw: unknown = JSON.parse(block);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the block must hold a JSON object");
    const cfg = raw as Record<string, unknown>;
    const known = ["highRiskPaths", "generatedPaths", "largePrLines"];
    const unknown = Object.keys(cfg).filter((k) => !known.includes(k));
    if (unknown.length) throw new Error(`unknown keys: ${unknown.join(", ")}`);
    const { largePrLines } = cfg;
    if (largePrLines !== undefined && (!Number.isInteger(largePrLines) || (largePrLines as number) <= 0)) {
      throw new Error("largePrLines must be a positive integer");
    }
    return {
      highRiskPaths: [...DEFAULT_CONFIG.highRiskPaths, ...stringList(cfg.highRiskPaths, "highRiskPaths")],
      generatedPaths: [...DEFAULT_CONFIG.generatedPaths, ...stringList(cfg.generatedPaths, "generatedPaths")],
      ...(largePrLines === undefined ? {} : { largePrLines: largePrLines as number }),
    };
  } catch (err) {
    return { ...DEFAULT_CONFIG, error: `REVIEW.md reviewer block: ${(err as Error).message}` };
  }
}
