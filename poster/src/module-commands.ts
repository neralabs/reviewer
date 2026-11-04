// CLI steps for the modules, the rules pass and the results sink. None of them needs npm dependencies: they run in
// jobs that install none.
//
//   modules                 modules job: run REVIEWER_MODULES (diff mode for a review, repository mode for a scan)
//   rules-pass-prepare      rules-pass job, before the model: its inputs, outside the first pass's reach
//   send <kind>             send job: the modules' sink records to RESULTS_SINK_URL

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestState, listReviews } from "./bot-history.ts";
import type { Decision } from "./gate.ts";
import { GitHub } from "./github.ts";
import { describeResults, moduleTarget, readModuleResults, runModules } from "./modules.ts";
import type { Finding } from "./render.ts";
import { findingsToRecommend, prepareRulesPass } from "./rules-pass.ts";
import { appendSummary, requireEnv, setOutputs, type Settings } from "./settings.ts";
import { buildBatch, sendBatch, type SinkRecord } from "./sink.ts";

function listEnv(name: string): string[] {
  return (process.env[name] ?? "").split(/[\s,]+/).filter(Boolean);
}

function readGate(work: string): Decision {
  return JSON.parse(readFileSync(join(work, "gate.json"), "utf8")) as Decision;
}

/** Never fails the job: every module's outcome, failures included, is in its results.json. */
export function modulesCommand(s: Settings): void {
  const gate = readGate(s.work);
  const mode = gate.mode === "scan" ? "repository" : "diff";
  const results = runModules(listEnv("REVIEWER_MODULES"), moduleTarget(s.work, mode, gate.baseRef), { home: s.home, work: s.work });
  appendSummary(`### Modules (${mode} mode)\n\n${describeResults(results) || "none"}`);
  const fresh = results.flatMap((r) => r.findings.filter((f) => f.state === "new"));
  setOutputs({ new_findings: fresh.length });
}

/**
 * Writes work/rules-pass/input/ from the first pass's findings and the modules' new findings, leaving out those an
 * earlier review already reported. Reads the bot's earlier review with the job's read-only token, before the model.
 */
export async function rulesPassPrepareCommand(s: Settings): Promise<void> {
  const gate = readGate(s.work);
  const pass1 = (JSON.parse(readFileSync(join(s.work, "findings.json"), "utf8")) as { findings?: Finding[] }).findings ?? [];
  const reviews = gate.pr ? await listReviews(new GitHub(requireEnv("GITHUB_TOKEN")), s.repo, gate.pr) : [];
  const prior = latestState(reviews, s.botLogin)?.findings ?? [];
  const given = prepareRulesPass(join(s.work, "rules-pass"), pass1, findingsToRecommend(readModuleResults(s.work), prior));
  appendSummary(`Rules pass: ${given} new module findings to recommend on.`);
  setOutputs({ given });
}

function isRecord(r: SinkRecord): boolean {
  return typeof r === "object" && r !== null && typeof r.type === "string" && typeof r.id === "string";
}

function readSinkFile(path: string, module: string): SinkRecord[] {
  const records = JSON.parse(readFileSync(path, "utf8")) as SinkRecord[];
  if (!Array.isArray(records) || !records.every(isRecord)) throw new Error(`${module}'s sink.json is not a list of records with a type and an id`);
  return records;
}

/** The records each module handed the sink (its sink.json), and the version of the first module that sent any. */
export function sinkRecords(work: string): { records: SinkRecord[]; toolVersion: string } {
  const handed = readModuleResults(work)
    .map((r) => ({ r, path: join(work, "modules", r.module, "sink.json") }))
    .filter(({ path }) => existsSync(path))
    .map(({ r, path }) => ({ version: r.version, records: readSinkFile(path, r.module) }));
  return { records: handed.flatMap((h) => h.records), toolVersion: handed.find((h) => h.records.length)?.version ?? "" };
}

export async function sendCommand([kind]: string[]): Promise<void> {
  if (!kind) throw new Error("usage: send <kind>");
  const { records, toolVersion } = sinkRecords(process.env.REVIEWER_WORK || "work");
  if (!records.length) {
    console.log("::notice::No module handed the results sink anything; nothing sent.");
    return;
  }
  const batch = buildBatch(records, {
    repository: requireEnv("GITHUB_REPOSITORY"),
    runId: requireEnv("GITHUB_RUN_ID"),
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
    kind,
    toolVersion,
    now: Date.now(),
  });
  await sendBatch(requireEnv("RESULTS_SINK_URL"), requireEnv("RESULTS_SINK_TOKEN"), batch);
  appendSummary(`Sent ${records.length} records to the results sink in batch \`${batch.batchId}\`.`);
}
