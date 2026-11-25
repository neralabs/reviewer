import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { baselineOf, packDirUnder, parseScan, scan, toResult, type Env } from "../run.ts";

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
  const repo = toResult(load(FIXTURE), "repository", new Set(), { error: 1, warning: 0, note: 0 }) as { findings: { state: string }[]; baseline?: object };
  assert.ok(repo.findings.every((f) => f.state === "existing"));
  // The merge base's counts go with a diff only: a branch scanned whole has no base to compare with.
  assert.equal(repo.baseline, undefined);
  const diff = toResult(load(FIXTURE), "diff", new Set(), { error: 1, warning: 0, note: 0 }) as { baseline?: object };
  assert.deepEqual(diff.baseline, { error: 1, warning: 0, note: 0 });
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

/**
 * Logs every call; prints the fixture for a git-diff scan (with FAKE_HEAD_CLEAN, the fixture with no violations) and
 * one of its violations for the other scans. With FAKE_READS_PACKS_FILE it reports the packs it ran, as a Rerail that
 * reads `.rerail/packs.json` does (#736); with FAKE_REFUSES_PACK_WITH_FILE it also refuses --pack where the scanned
 * tree has that file, as one before #829 does.
 */
const FAKE_RERAIL = `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), args, headless: process.env.RERAIL_EXPERIMENTAL_HEADLESS_SCAN ?? null }) + "\\n");
if (args[0] !== "scan") process.exit(0);
if (process.env.FAKE_REFUSES_PACK_WITH_FILE && args.includes("--pack") && fs.existsSync(".rerail/packs.json")) {
  process.stderr.write("--pack: this repository lists its packs in .rerail/packs.json; add them there instead");
  process.exit(1);
}
const head = JSON.parse(fs.readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));
const scope = args[args.indexOf("--scope") + 1];
const packs = process.env.FAKE_READS_PACKS_FILE ? { packs: [] } : {};
const found = scope !== "git-diff" ? [head.violations[1]] : process.env.FAKE_HEAD_CLEAN ? [] : head.violations;
process.stdout.write(JSON.stringify({ ...head, ...(scope === "git-diff" ? {} : { scope }), violations: found, ...packs }));
`;

/** A Rerail that reads `.rerail/packs.json` and takes --pack beside it (#829), and one that refuses it (#736 only). */
const READS_FILE = { FAKE_READS_PACKS_FILE: "1" };
const REFUSES_PACK = { FAKE_READS_PACKS_FILE: "1", FAKE_REFUSES_PACK_WITH_FILE: "1" };

/**
 * A repository whose main has a pack and a rule, and a PR that renames the pack and adds its own pack and rule, laid
 * out as the modules job lays it out: checkout (the PR head), base-tip (a worktree at main), out/ and home/. With
 * `packsFile`, main has it as `.rerail/packs.json`, and the PR lists its own pack there too.
 */
function workspace({ script = FAKE_RERAIL, packsFile }: { script?: string; packsFile?: { packs: object[] } } = {}) {
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
  const listing = (packs: object[]) => ({ ".rerail/packs.json": JSON.stringify({ schema: "rerail.packs/1", packs }) });
  git("init", "-q", "-b", "main");
  put({ "src/log.ts": "console.log(1)\n", ...pack("team"), ...rule("base-rule"), ...(packsFile ? listing(packsFile.packs) : {}) });
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  put({ "src/db.ts": "sql\n", "packs/team/pack.json": JSON.stringify({ id: "pr-renamed" }), ...rule("pr-rule"), ...pack("pr-only") });
  if (packsFile) put(listing([...packsFile.packs, { path: "packs/pr-only" }]));
  git("add", "-A");
  git("commit", "-qm", "pr");
  git("worktree", "add", "--quiet", "--detach", join(root, "base-tip"), base);
  const bin = join(root, "rerail");
  writeFileSync(bin, `#!/usr/bin/env node\n${script}`);
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

function withFake<T>(bin: string, log: string, fn: () => T, fakeEnv: Record<string, string> = {}): T {
  Object.assign(process.env, { RERAIL_BIN: bin, FAKE_LOG: log, ...fakeEnv });
  try {
    return fn();
  } finally {
    for (const name of ["RERAIL_BIN", "FAKE_LOG", ...Object.keys(fakeEnv)]) delete process.env[name];
  }
}

const calls = (log: string) => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cwd: string; args: string[]; headless: string | null });

test("diff mode: approval only from the base checkout, the PR scanned with the base's rules, the merge base for the files it touches", () => {
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
    // A scan with no session needs Rerail's headless-scan experiment; nothing else runs with it.
    assert.deepEqual(all.map((c) => [c.args[0], c.headless]), [["packs", null], ["rules", null], ["rules", null], ["scan", "1"], ["scan", "1"]]);
    assert.deepEqual(head!.args, ["scan", "--scope", "git-diff", "--base", env.mergeBase, "--rules-ref", env.baseSha, "--pack", "typescript", "--pack", "team", "--json"]);
    assert.equal(realpathSync(head!.cwd), realpathSync(env.checkout));
    assert.deepEqual(mergeBase!.args.slice(0, 4), ["scan", "--scope", "repository", "--paths-from"]);
    // What the PR changed that the base has, then the file the head scan found a violation in. src/db.ts is new.
    assert.equal(readFileSync(mergeBase!.args[4]!, "utf8"), "packs/team/pack.json\nsrc/log.ts\n");

    const result = JSON.parse(readFileSync(join(env.out, "results.json"), "utf8")) as { status: string; findings: { fingerprint: string; state: string }[]; baseline: object };
    assert.equal(result.status, "completed");
    assert.deepEqual(result.findings.map((f) => [f.fingerprint, f.state]), [["fp-sql-new", "new"], ["fp-console-old", "existing"], ["fp-const-new", "new"]]);
    // The fake's merge-base scan finds one violation of a steer rule.
    assert.deepEqual(result.baseline, { error: 0, warning: 1, note: 0 });
    const sink = JSON.parse(readFileSync(join(env.out, "sink.json"), "utf8")) as { type: string; id: string }[];
    assert.deepEqual(sink.map((r) => [r.type, r.id]), [["scan", load(FIXTURE).scanId]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the merge base is scanned even when the PR's files are clean, so what it fixed or deleted still counts", () => {
  const { root, env, bin, log } = workspace();
  try {
    rmSync(join(env.checkout, "packs", "team", "package.json"));
    for (const args of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "delete a file"]]) {
      execFileSync("git", args, { cwd: env.checkout });
    }
    withFake(bin, log, () => scan(env), { FAKE_HEAD_CLEAN: "1" });
    const mergeBase = calls(log).filter((c) => c.args[0] === "scan")[1]!;
    // The file the PR changed and the one it deleted; the base has neither of the files the PR added.
    assert.equal(readFileSync(mergeBase.args[4]!, "utf8"), "packs/team/pack.json\npacks/team/package.json\n");
    const result = JSON.parse(readFileSync(join(env.out, "results.json"), "utf8")) as { status: string; findings: object[]; baseline: object };
    assert.equal(result.status, "completed");
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.baseline, { error: 0, warning: 1, note: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the merge base's violations are counted by level, and a merge base with nothing to scan counts none", () => {
  // The fixture has one violation of a block rule, one of a steer rule and one of a log rule.
  assert.deepEqual(baselineOf(load(FIXTURE)), { error: 1, warning: 1, note: 1 });
  assert.deepEqual(baselineOf(undefined), { error: 0, warning: 0, note: 0 });
  const { root, env, bin, log } = workspace();
  try {
    // A change that touches no file the merge base has: here, the head itself as the merge base.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.checkout, encoding: "utf8" }).trim();
    withFake(bin, log, () => scan({ ...env, mergeBase: head }), { FAKE_HEAD_CLEAN: "1" });
    assert.equal(calls(log).filter((c) => c.args[0] === "scan").length, 1, "no merge-base scan");
    const result = JSON.parse(readFileSync(join(env.out, "results.json"), "utf8")) as { status: string; baseline: object };
    assert.deepEqual([result.status, result.baseline], ["completed", { error: 0, warning: 0, note: 0 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a link the change removes doesn't add what it pointed at to the merge base's count", () => {
  const { root, env, bin, log } = workspace();
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: env.checkout, encoding: "utf8" }).trim();
  try {
    // The merge base has a link to a file the change leaves alone; the change deletes only the link.
    symlinkSync("src/log.ts", join(env.checkout, "link.ts"));
    git("add", "-A");
    git("commit", "-qm", "a link");
    const mergeBase = git("rev-parse", "HEAD");
    rmSync(join(env.checkout, "link.ts"));
    git("commit", "-qam", "delete the link");
    withFake(bin, log, () => scan({ ...env, mergeBase }), { FAKE_HEAD_CLEAN: "1" });
    assert.equal(calls(log).filter((c) => c.args[0] === "scan").length, 1, "the link is not scanned as the file it points at");
    const result = JSON.parse(readFileSync(join(env.out, "results.json"), "utf8")) as { baseline: object };
    assert.deepEqual(result.baseline, { error: 0, warning: 0, note: 0 });
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

/** Rerail's own pack from npm and a pack the repository keeps, as `.rerail/packs.json` lists them. */
const LISTED = { packs: [{ id: "complexity", version: "0.1.8" }, { path: "packs/team" }] };

test("with .rerail/packs.json and both inputs empty, the file decides: no --pack, the base's listed path packs approved", () => {
  const { root, env, bin, log } = workspace({ packsFile: LISTED });
  try {
    withFake(bin, log, () => scan({ ...env, packs: [], repoPacks: [] }), READS_FILE);
    const all = calls(log);
    // Nothing is added. The PR's file also lists packs/pr-only; only the base's packs/team is approved, by the
    // listing Rerail reads from --repo under the headless-scan experiment.
    assert.deepEqual(
      all.filter((c) => c.args[0] !== "scan").map((c) => [c.args, c.headless]),
      [
        [["rules", "approve", "@team/rerail-pack-team", "--repo", env.baseCheckout], "1"],
        [["rules", "approve", "base-rule", "--repo", env.baseCheckout], null],
      ],
    );
    // A probe of the installed Rerail, then the PR and the merge base, neither with --pack.
    const [, head, mergeBase, ...rest] = all.filter((c) => c.args[0] === "scan");
    assert.equal(rest.length, 0);
    assert.deepEqual(head!.args, ["scan", "--scope", "git-diff", "--base", env.mergeBase, "--rules-ref", env.baseSha, "--json"]);
    assert.deepEqual(mergeBase!.args.slice(5), ["--rules-ref", env.baseSha, "--json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path the base's .rerail/packs.json lists must be a pack on the base branch, inside it", () => {
  for (const [path, message] of [
    ["packs/pr-only", /pack path packs\/pr-only is not on the base branch/],
    ["../outside", /without \.\./],
  ] as const) {
    const { root, env, bin, log } = workspace({ packsFile: { packs: [{ path }] } });
    try {
      assert.throws(() => withFake(bin, log, () => scan({ ...env, packs: [], repoPacks: [] }), READS_FILE), message, path);
      assert.deepEqual(calls(log).map((c) => c.args[0]), ["scan"], "nothing approved, only the probe ran");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("with .rerail/packs.json and an input set, the inputs replace the file's packs with --pack", () => {
  const { root, env, bin, log } = workspace({ packsFile: LISTED });
  try {
    withFake(bin, log, () => scan(env), READS_FILE);
    const all = calls(log);
    // rerail_repo_packs is added and approved from the base checkout, as without the file; the file's path packs
    // are not approved.
    assert.deepEqual(
      all.filter((c) => c.args[0] !== "scan").map((c) => c.args),
      [
        ["packs", "add", join(realpathSync(env.baseCheckout), "packs", "team")],
        ["rules", "approve", "@team/rerail-pack-team", "--repo", env.baseCheckout],
        ["rules", "approve", "base-rule", "--repo", env.baseCheckout],
      ],
    );
    // The probe asks whether this Rerail takes --pack beside the file; then the PR and the merge base, both with it.
    const scans = all.filter((c) => c.args[0] === "scan");
    assert.equal(scans.length, 3);
    const packArgs = ["--pack", "typescript", "--pack", "team"];
    assert.deepEqual(scans[0]!.args.slice(-5, -1), packArgs);
    assert.notEqual(realpathSync(scans[0]!.cwd), realpathSync(env.checkout));
    assert.deepEqual(scans[1]!.args.slice(5), ["--rules-ref", env.baseSha, ...packArgs, "--json"]);
    assert.deepEqual(scans[2]!.args.slice(5), ["--rules-ref", env.baseSha, ...packArgs, "--json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with .rerail/packs.json and an input set, a Rerail that refuses --pack beside the file fails the module, naming the release", () => {
  const { root, env, bin, log } = workspace({ packsFile: LISTED });
  try {
    assert.throws(() => withFake(bin, log, () => scan(env), REFUSES_PACK), /refuses --pack beside that file: that needs a Rerail release with neralabs\/rerail#829.*lists its packs in \.rerail\/packs\.json/);
    // Only probes ran: the change was never scanned without the packs the inputs name.
    const scans = calls(log).filter((c) => c.args[0] === "scan");
    assert.ok(scans.every((c) => realpathSync(c.cwd) !== realpathSync(env.checkout)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with .rerail/packs.json, an input set and a Rerail that doesn't read the file, --pack decides as before", () => {
  const { root, env, bin, log } = workspace({ packsFile: LISTED });
  try {
    withFake(bin, log, () => scan(env));
    const head = calls(log).filter((c) => c.args[0] === "scan")[1]!;
    assert.deepEqual(head.args.slice(5), ["--rules-ref", env.baseSha, "--pack", "typescript", "--pack", "team", "--json"]);
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
  const { root, env, bin, log } = workspace({ script: `process.stderr.write("engine missing"); process.exit(2);` });
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
