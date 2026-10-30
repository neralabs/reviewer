// Runtime settings. The reusable workflow sets these from its inputs; the
// GITHUB_* ones are the runner's own.

import { appendFileSync } from "node:fs";
import { parseRepo, type RepoRef } from "./github.ts";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

export interface Settings {
  repo: RepoRef;
  repoFullName: string;
  teamSlug: string;
  handle: string;
  botLogin: string;
  approvalsEnabled: boolean;
  largePrLines: number;
  /** Working directory shared by the steps of one job: gate.json, context/, findings.json. */
  work: string;
  /** Checkout of neralabs/reviewer: skill, prompts, schema, agents. */
  home: string;
  runUrl: string;
}

export function settings(): Settings {
  const repoFullName = requireEnv("GITHUB_REPOSITORY");
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const largePrLines = Number(process.env.REVIEWER_LARGE_PR_LINES ?? 50000);
  if (!Number.isInteger(largePrLines) || largePrLines <= 0) throw new Error("REVIEWER_LARGE_PR_LINES must be a positive integer");
  return {
    repo: parseRepo(repoFullName),
    repoFullName,
    teamSlug: process.env.REVIEWER_TEAM_SLUG || "reviewer",
    handle: process.env.REVIEWER_HANDLE || "@neralabs-reviewer",
    botLogin: process.env.REVIEWER_BOT_LOGIN || "neralabs-reviewer[bot]",
    approvalsEnabled: process.env.REVIEWER_ALLOW_APPROVE === "true",
    largePrLines,
    work: process.env.REVIEWER_WORK || "work",
    home: process.env.REVIEWER_HOME || "reviewer",
    runUrl: `${server}/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID ?? "0"}`,
  };
}

/** Sets step outputs. Values are single-line by construction; untrusted text goes in files, not outputs. */
export function setOutputs(outputs: Record<string, string | number | boolean | undefined>): void {
  const file = process.env.GITHUB_OUTPUT;
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${String(v ?? "").replace(/[\r\n]/g, " ")}`);
  if (file) appendFileSync(file, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
}

export function appendSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
  else console.log(markdown);
}
