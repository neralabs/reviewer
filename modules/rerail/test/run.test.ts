import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { packDirUnder, parseScan, scan, toResult, type Env } from "../run.ts";

const FIXTURE = new URL("./fixtures/rerail-scan.json", import.meta.url).pathname;
const REAL = new URL("./fixtures/c3-scan-rerail.json", import.meta.url).pathname;
const RUN = new URL("../run.ts", import.meta.url).pathname;
const load = (path: string) => parseScan(readFileSync(path, "utf8"));

test("a real rerail.scan/1 result parses; anything else is refused", () => {
  assert.equal(load(REAL).violations.length, 12);
  assert.throws(() => parseScan(JSON.stringify({ schema: "rerail.scan/2", rules: [], violations: [] })), /not a rerail.scan\/1/);
  assert.throws(() => parseScan(JSON.stringify({ schema: "rerail.scan/1" })), /no rules or violations/);
});

test("a scan becomes a module result: rule modes map to levels, and the merge base decides new or existing", () => {
  const result = toResult(load(FIXTURE), "diff", new Set(["fp-console-old"])) as {
    checks: { id: string; level: string }[];
    findings: { checkId: string; level: string; state: string; module: string }[];
  };
  assert.deepEqual(result.checks, [
    { id: "no-raw-sql", level: "error" },
    { id: "no-console-log", level: "warning" },
    { id: "prefer-const", level: "note" },
  ]);
  assert.deepEqual(
    result.findings.map((f) => [f.module, f.checkId, f.level, f.state]),
    [
      ["rerail", "no-raw-sql", "error", "new"],
      ["rerail", "no-console-log", "warning", "existing"],
      ["rerail", "prefer-const", "note", "new"],
    ],
  );
  const repo = toResult(load(FIXTURE), "repository", new Set()) as { findings: { state: string }[] };
  assert.ok(repo.findings.every((f) => f.state === "existing"));
});

test("a repository pack path resolves only inside the base checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "pack-path-"));
  const base = join(root, "base");
  const outside = join(root, "pr", "packs", "team");
  for (const dir of [join(base, "packs", "team"), outside, join(base, "packs", "empty")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(base, "packs", "team", "pack.json"), "{}");
  writeFileSync(join(outside, "pack.json"), "{}");
  symlinkSync(outside, join(base, "packs", "to-pr"));
  symlinkSync(join(base, "packs", "team"), join(base, "packs", "alias"));
  try {
    const real = realpathSync(join(base, "packs", "team"));
    assert.equal(packDirUnder(base, "packs/team"), real);
    assert.equal(packDirUnder(base, "./packs/team/"), real);
    assert.equal(packDirUnder(base, "packs/alias"), real);
    for (const [rel, message] of [
      ["", /relative to the repository root/],
      [outside, /relative to the repository root/],
      ["../pr/packs/team", /without \.\./],
      ["packs/../../pr/packs/team", /without \.\./],
      ["packs/to-pr", /leads out of the base branch's checkout/],
      ["packs/missing", /not on the base branch/],
      ["packs/empty", /no pack\.json/],
    ] as const) {
      assert.throws(() => packDirUnder(base, rel), message, rel);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Logs every call; prints the fixture for a git-diff scan and one of its violations for the merge-base scan. */
const FAKE_RERAIL = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
if (args[0] !== "scan") process.exit(0);
const head = JSON.parse(fs.readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));
const scope = args[args.indexOf("--scope") + 1];
process.stdout.write(JSON.stringify(scope === "git-diff" ? head : { ...head, scope, violations: [head.violations[1]] }));
`;

/**
 * A repository whose main has a pack and a rule, and a PR that renames the pack and adds its own pack and rule, laid
 * out as the modules job lays it out: checkout (the PR head), base-tip (a worktree at main), out/ and home/.
 */
function workspace(rerailScript = FAKE_RERAIL) {
  const root = mkdtempSync(join(tmpdir(), "rerail-module-"));
  const checkout = join(root, "pr");
  mkdirSync(checkout);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: checkout, encoding: "utf8" }).trim();
  const put = (tree: Record<string, string>) => {
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(checkout, path)), { recursive: true });
      writeFileSync(join(checkout, path), text);
    }
  };
  const pack = (id: string) => ({ [`packs/${id}/pack.json`]: JSON.stringify({ id }), [`packs/${id}/package.json`]: JSON.stringify({ name: `@team/rerail-pack-${id}` }) });
  const rule = (id: string) => ({ [`.rerail/rules/${id}.json`]: JSON.stringify({ format: "rerail.policy/v1", id }) });
  git("init", "-q", "-b", "main");
  put({ "src/log.ts": "console.log(1)\n", ...pack("team"), ...rule("base-rule") });
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  put({ "src/db.ts": "sql\n", "packs/team/pack.json": JSON.stringify({ id: "pr-renamed" }), ...rule("pr-rule"), ...pack("pr-only") });
  git("add", "-A");
  git("commit", "-qm", "pr");
  git("worktree", "add", "--quiet", "--detach", join(root, "base-tip"), base);
  const bin = join(root, "rerail");
  writeFileSync(bin, `#!/usr/bin/env node\n${rerailScript}`);
  chmodSync(bin, 0o755);
  for (const dir of ["out", "home"]) mkdirSync(join(root, dir));
  const env: Env = {
    mode: "diff",
    checkout,
    baseCheckout: join(root, "base-tip"),
    baseSha: base,
    mergeBase: base,
    home: join(root, "home"),
    out: join(root, "out"),
    packs: ["typescript"],
    repoPacks: ["packs/team"],
  };
  return { root, env, bin, log: join(root, "calls.jsonl") };
}

function withFake<T>(bin: string, log: string, fn: () => T): T {
  process.env.RERAIL_BIN = bin;
  process.env.FAKE_LOG = log;
  try {
    return fn();
  } finally {
    delete process.env.RERAIL_BIN;
    delete process.env.FAKE_LOG;
  }
}

const calls = (log: string) => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cwd: string; args: string[] });

test("diff mode: approval only from the base checkout, the PR scanned with the base's rules, the merge base for the same files", () => {
  const { root, env, bin, log } = workspace();
  try {
    withFake(bin, log, () => scan(env));
    const all = calls(log);
    const base = realpathSync(env.baseCheckout);
    // The PR renamed the pack and added its own pack and rule: only the base branch's are approved.
    assert.deepEqual(
      all.filter((c) => c.args[0] !== "scan").map((c) => c.args),
      [
        ["packs", "add", join(base, "packs", "team")],
        ["rules", "approve", "@team/rerail-pack-team", "--repo", env.baseCheckout],
        ["rules", "approve", "base-rule", "--repo", env.baseCheckout],
      ],
    );
    const [head, mergeBase] = all.filter((c) => c.args[0] === "scan");
    assert.deepEqual(head!.args, ["scan", "--scope", "git-diff", "--base", env.mergeBase, "--rules-ref", env.baseSha, "--pack", "typescript", "--pack", "team", "--json"]);
    assert.equal(realpathSync(head!.cwd), realpathSync(env.checkout));
    assert.deepEqual(mergeBase!.args.slice(0, 4), ["scan", "--scope", "repository", "--paths-from"]);
    assert.equal(readFileSync(mergeBase!.args[4]!, "utf8"), "src/log.ts\n"); // src/db.ts is new in the PR

    const result = JSON.parse(readFileSync(join(env.out, "results.json"), "utf8")) as { status: string; findings: { fingerprint: string; state: string }[] };
    assert.equal(result.status, "completed");
    assert.deepEqual(result.findings.map((f) => [f.fingerprint, f.state]), [["fp-sql-new", "new"], ["fp-console-old", "existing"], ["fp-const-new", "new"]]);
    const sink = JSON.parse(readFileSync(join(env.out, "sink.json"), "utf8")) as { type: string; id: string }[];
    assert.deepEqual(sink.map((r) => [r.type, r.id]), [["scan", load(FIXTURE).scanId]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pack only the PR has is not on the base branch: the module fails rather than scan without it", () => {
  const { root, env, bin, log } = workspace();
  try {
    assert.throws(() => withFake(bin, log, () => scan({ ...env, repoPacks: ["packs/pr-only"] })), /pack path packs\/pr-only is not on the base branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository mode scans the branch with its own rules and no merge-base scan", () => {
  const { root, env, bin, log } = workspace();
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.checkout, encoding: "utf8" }).trim();
    withFake(bin, log, () => scan({ ...env, mode: "repository", baseCheckout: env.checkout, baseSha: head, mergeBase: head, repoPacks: [] }));
    const scans = calls(log).filter((c) => c.args[0] === "scan");
    assert.equal(scans.length, 1);
    assert.deepEqual(scans[0]!.args.slice(1, 5), ["--scope", "repository", "--rules-ref", head]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run.ts records a failure in results.json and exits 0, so the review goes on", () => {
  const { root, env, bin, log } = workspace(`process.stderr.write("engine missing"); process.exit(2);`);
  try {
    const run = spawnSync("node", [RUN], {
      encoding: "utf8",
      env: {
        ...process.env,
        RERAIL_BIN: bin,
        FAKE_LOG: log,
        MODULE_MODE: "diff",
        MODULE_CHECKOUT: env.checkout,
        MODULE_BASE_CHECKOUT: env.baseCheckout,
        MODULE_BASE_SHA: env.baseSha,
        MODULE_MERGE_BASE: env.mergeBase,
        MODULE_HOME: env.home,
        MODULE_OUT: env.out,
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(join(env.out, "results.json"), "utf8")) as { status: string; error: string; module: string };
    assert.equal(result.module, "rerail");
    assert.equal(result.status, "failed");
    assert.match(result.error, /failed \(exit 2\): engine missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
