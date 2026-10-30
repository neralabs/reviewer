import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { numstat, patchOf, reviewMode, scrub } from "../src/prepare.ts";

test("a review of a PR the bot reviewed before is a re-review; review full or a first review is a full pass", () => {
  // A fresh full pass over an already-reviewed head finds new things in the same code each time.
  // Pushes no longer re-review, so `review` or re-requesting the team after new commits must cover only the delta.
  assert.equal(reviewMode({ mode: "review", full: false }, "a5a0171"), "rereview");
  assert.equal(reviewMode({ mode: "review", full: true }, "a5a0171"), "review");
  assert.equal(reviewMode({ mode: "review", full: false }, undefined), "review");
  assert.equal(reviewMode({ mode: "rereview", full: false }, "29835aa"), "rereview");
});

test("scrub deletes PR-controlled AGENTS.md files at any depth, keeping other files", () => {
  // Audit M1: Claude Code loads AGENTS.md as instructions when a project has no CLAUDE.md, so a PR could steer the model.
  const root = mkdtempSync(join(tmpdir(), "scrub-"));
  mkdirSync(join(root, "pkg", "sub"), { recursive: true });
  for (const file of ["AGENTS.md", "AGENTS.override.md", "README.md", "pkg/AGENTS.md", "pkg/sub/AGENTS.override.md", "pkg/main.ts"]) {
    writeFileSync(join(root, file), "x");
  }
  const found: string[] = [];
  scrub(root, found, [], "pr/");
  assert.deepEqual(found.sort(), ["pr/AGENTS.md", "pr/AGENTS.override.md", "pr/pkg/AGENTS.md", "pr/pkg/sub/AGENTS.override.md"]);
  assert.ok(existsSync(join(root, "README.md")));
  assert.ok(existsSync(join(root, "pkg", "main.ts")));
  assert.ok(!existsSync(join(root, "pkg", "AGENTS.md")));
});

test("a changed file whose name git would C-quote still reaches the patch", () => {
  // Audit M5(a): plain --numstat printed "run\"me.js", which as a :(literal) pathspec matched nothing,
  // so the change was missing from diff.patch and the model never saw it.
  const repo = mkdtempSync(join(tmpdir(), "numstat-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
    const names = ['run"me.js', "back\\slash.js", "tab\there.js"];
    git("init", "-q");
    for (const n of names) writeFileSync(join(repo, n), "one\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const from = git("rev-parse", "HEAD");
    for (const n of names) writeFileSync(join(repo, n), "one\ntwo\n");
    git("commit", "-qam", "b");

    const files = numstat(repo, from, "HEAD");
    assert.deepEqual(files.map((f) => f.filename).sort(), [...names].sort());
    assert.ok(files.every((f) => f.additions === 1 && f.deletions === 0));
    for (const f of files) assert.match(patchOf(repo, from, "HEAD", [f.filename]), /^\+two$/m, f.filename);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
