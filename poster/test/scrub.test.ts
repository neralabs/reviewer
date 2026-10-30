import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scrub } from "../src/prepare.ts";

test("scrub removes every symlink in the tree without following it, and leaves .git and regular files alone", () => {
  // Audit H2: pr/x -> /proc/self/environ let the model's file tools read the review job's environment.
  const root = mkdtempSync(join(tmpdir(), "scrub-"));
  try {
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "canary.txt"), "canary");
    const pr = join(root, "pr");
    mkdirSync(join(pr, "src", "deep"), { recursive: true });
    mkdirSync(join(pr, ".git"));
    writeFileSync(join(pr, "src", "main.ts"), "code");
    writeFileSync(join(pr, "CLAUDE.md"), "instructions");
    symlinkSync("../outside/canary.txt", join(pr, "leak"));
    symlinkSync("/proc/self/environ", join(pr, "src", "deep", "env"));
    symlinkSync("../outside", join(pr, "src", "outdir"));
    symlinkSync("../outside/canary.txt", join(pr, ".git", "kept"));

    const found: string[] = [];
    const links: string[] = [];
    scrub(pr, found, links, "pr/");

    assert.deepEqual(found, ["pr/CLAUDE.md"]);
    assert.deepEqual([...links].sort(), ["pr/leak", "pr/src/deep/env", "pr/src/outdir"]);
    for (const link of ["leak", "src/deep/env", "src/outdir"]) assert.equal(lstatSync(join(pr, link), { throwIfNoEntry: false }), undefined);
    assert.equal(readFileSync(join(pr, "src", "main.ts"), "utf8"), "code");
    assert.ok(lstatSync(join(pr, ".git", "kept")).isSymbolicLink());
    // The link to a directory was removed, not recursed into: the target survives.
    assert.equal(readFileSync(join(root, "outside", "canary.txt"), "utf8"), "canary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
