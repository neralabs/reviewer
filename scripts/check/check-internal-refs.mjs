#!/usr/bin/env node
// No internal references in a tracked file's path or text. The repository is public and what these point to is not:
//
// - ticket IDs (`NER-` and digits, any case): name the behavior, the pull request or the commit instead;
// - 12-digit AWS account IDs: use a placeholder such as 123456789012 only where an example needs one;
// - staff addresses at nera.software: use opensource@nera.software.
//
// Scope: every tracked path, and the text of every tracked file Git does not take for binary (`git grep -I`).
// Commit messages and pull request titles are not checked.
//
//   node scripts/check/check-internal-refs.mjs
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Each pattern's source is also its `git grep -P` pattern, so paths and text match alike. */
export const PATTERNS = [
  { name: "an internal ticket ID", regex: /\bner-\d+/iu, exclude: [] },
  // 123456789012 is the placeholder AWS documents use.
  { name: "an AWS account ID", regex: /(?<![\d.])(?!123456789012\b)\d{12}(?![\d.])/u, exclude: [] },
  { name: "a staff address", regex: /\b(?!opensource@)[\w.+-]+@nera\.software\b/iu, exclude: [] },
];

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

const excluded = (path, exclude) => exclude.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix));

/** Every tracked path and text line under `root` that matches a pattern, as `{ path, line, text, name }` (`line` 0 for a path). */
export function internalRefProblems(root) {
  const paths = git(root, ["ls-files", "-z"]).split("\0").filter((path) => path !== "");
  const problems = [];
  for (const { name, regex, exclude } of PATTERNS) {
    for (const path of paths) {
      if (regex.test(path) && !excluded(path, exclude)) problems.push({ path, line: 0, text: path, name });
    }
    let matches = "";
    try {
      matches = git(root, ["grep", "-I", "-n", "-z", "-P", ...(regex.flags.includes("i") ? ["-i"] : []), "-e", regex.source]);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    for (const record of matches.split("\n")) {
      if (record === "") continue;
      const [path, line, text] = record.split("\0");
      if (!excluded(path, exclude)) problems.push({ path, line: Number(line), text: text.trim(), name });
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const problems = internalRefProblems(root);
  for (const { path, line, text, name } of problems) {
    console.error(line === 0 ? `${path}: the path names ${name}` : `${path}:${line}: ${name}: ${text.slice(0, 160)}`);
  }
  console.log(
    problems.length === 0
      ? "check-internal-refs: no internal references in tracked files"
      : `check-internal-refs: ${problems.length} internal reference(s); see the header of this script for what to use instead`,
  );
  process.exit(problems.length === 0 ? 0 : 1);
}
