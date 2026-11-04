#!/usr/bin/env node
// Entry point for the reusable workflow's steps:
//   gate                   decide what this event means; writes $REVIEWER_WORK/gate.json and step outputs
//   prepare                build the review context bundle (review job, before the model)
//   agents <out.json>      build the --agents file for claude -p
//   post                   validate findings.json and post the review (poster job)
//   respond <mode>         help | stop | failure
//   redact <file>...       redact credentials in place (the session transcript, before upload)
//   modules                modules job: run the caller's modules (module-commands.ts)
//   rules-pass-prepare     rules-pass job: the second model step's inputs
//   send <kind>            send job: module results to the results sink

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgents } from "./agents.ts";
import { decide, type GateDeps, type PullRequest } from "./gate.ts";
import { GitHub, GitHubError } from "./github.ts";
import { prepare } from "./prepare.ts";
import { modulesCommand, rulesPassPrepareCommand, sendCommand } from "./module-commands.ts";
import { respond } from "./respond.ts";
import { appendSummary, requireEnv, setOutputs, settings, type Settings } from "./settings.ts";
import { redactSecrets } from "./text.ts";

async function gate(s: Settings): Promise<void> {
  const gh = new GitHub(requireEnv("GITHUB_TOKEN"));
  const { owner, repo } = s.repo;
  const deps: GateDeps = {
    async permission(user) {
      try {
        const res = await gh.get<{ permission: string }>(`/repos/${owner}/${repo}/collaborators/${encodeURIComponent(user)}/permission`);
        return res.permission;
      } catch (err) {
        if (err instanceof GitHubError && err.status === 404) return "none";
        throw err;
      }
    },
    pullRequest: (n) => gh.get<PullRequest>(`/repos/${owner}/${repo}/pulls/${n}`),
    reviewComment: (id) => gh.get(`/repos/${owner}/${repo}/pulls/comments/${id}`),
  };
  const payload = JSON.parse(readFileSync(requireEnv("GITHUB_EVENT_PATH"), "utf8"));
  const decision = await decide(requireEnv("GITHUB_EVENT_NAME"), payload, s, deps);

  mkdirSync(s.work, { recursive: true });
  writeFileSync(join(s.work, "gate.json"), `${JSON.stringify(decision, null, 2)}\n`);
  setOutputs({
    mode: decision.mode,
    pr: decision.pr,
    head_sha: decision.headSha,
    head_repo: decision.headRepo,
  });
  console.log(`gate: ${decision.mode} (${decision.reason})`);
  if (decision.mode !== "skip") appendSummary(`Gate: **${decision.mode}** for #${decision.pr}: ${decision.reason}.`);
}

// Needs no repo settings: the review job runs it on the transcript whatever state the run ended in, so a
// file the run never wrote is skipped, as the upload skips it.
function redact(args: string[]): void {
  if (!args.length) throw new Error("usage: redact <file>...");
  for (const file of args.filter((f) => existsSync(f))) writeFileSync(file, redactSecrets(readFileSync(file, "utf8")));
}

/** Commands that need no repository settings. */
const STANDALONE: Record<string, (args: string[]) => void | Promise<void>> = {
  redact,
  send: sendCommand,
};

async function prepareCommand(s: Settings): Promise<void> {
  const m = await prepare(s);
  appendSummary(`Context for #${m.pr}: ${m.scope}. ${m.size.lines} changed lines in ${m.size.files} files. Specialists by file type: ${m.specialists.join(", ") || "none"}.`);
}

function need(arg: string | undefined, usage: string): string {
  if (!arg) throw new Error(`usage: ${usage}`);
  return arg;
}

const WITH_SETTINGS: Record<string, (s: Settings, args: string[]) => void | Promise<void>> = {
  gate: (s) => gate(s),
  prepare: prepareCommand,
  modules: (s) => modulesCommand(s),
  "rules-pass-prepare": (s) => rulesPassPrepareCommand(s),
  agents: (s, [out]) => writeFileSync(need(out, "agents <out.json>"), JSON.stringify(buildAgents(join(s.home, "agents")), null, 2)),
  post: async (s) => {
    // Static import can't work here: post.ts pulls in ajv, which only the poster job installs.
    const { post } = await import("./post.ts");
    return post(s);
  },
  respond: (s, [mode]) => respond(s, need(mode, "respond <mode>")),
};

async function main(): Promise<void> {
  const [command = "", ...args] = process.argv.slice(2);
  const standalone = STANDALONE[command];
  if (standalone) return standalone(args);
  const run = WITH_SETTINGS[command];
  if (!run) throw new Error(`unknown command: ${command || "(none)"}`);
  return run(settings(), args);
}

main().catch((err: unknown) => {
  console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
