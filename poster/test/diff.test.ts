import assert from "node:assert/strict";
import { test } from "node:test";
import { commentableLines, diffSize, sampleGenerated } from "../src/diff.ts";
import { DEFAULT_CONFIG } from "../src/review-config.ts";

test("commentable lines are the head side of each hunk: added and context lines, not removed ones", () => {
  const patch = [
    "@@ -1,3 +1,4 @@",
    " a",
    "-b",
    "+B",
    "+C",
    " d",
    "@@ -20,2 +21,2 @@ fn x()",
    " y",
    "-z",
    "+Z",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  assert.deepEqual([...commentableLines(patch)], [1, 2, 3, 4, 21, 22]);
});

test("a file without a patch (binary or too large) has no commentable lines", () => {
  assert.equal(commentableLines(undefined).size, 0);
});

test("diff size leaves out lock files and generated paths", () => {
  const size = diffSize(
    [
      { filename: "src/a.ts", additions: 10, deletions: 5 },
      { filename: "package-lock.json", additions: 4000, deletions: 3000 },
      { filename: "web/dist/app.min.js", additions: 900, deletions: 0 },
      { filename: "gen/schema.ts", additions: 50, deletions: 0 },
    ],
    [...DEFAULT_CONFIG.generatedPaths, "/gen/"],
  );
  assert.deepEqual(size, { lines: 15, files: 1, excludedFiles: ["package-lock.json", "web/dist/app.min.js", "gen/schema.ts"] });
});

test("the generated sample takes the largest file from each of the busiest directories, one per directory", () => {
  const sample = sampleGenerated(
    [
      { filename: "packs/ts/upstream/goldens.tsv", additions: 27000, deletions: 0 },
      { filename: "packs/ts/upstream/fixture-a.ts", additions: 40, deletions: 0 },
      { filename: "packs/py/upstream/fixtures/long_set.py", additions: 7000, deletions: 0 },
      { filename: "packs/py/upstream/fixtures/small.py", additions: 3, deletions: 1 },
      { filename: "packs/react/upstream/a.jsx", additions: 5, deletions: 0 },
      { filename: "packs/react/upstream/b.jsx", additions: 9, deletions: 0 },
      { filename: "package-lock.json", additions: 100, deletions: 50 },
    ],
    3,
  );
  assert.deepEqual(sample, ["packs/ts/upstream/goldens.tsv", "packs/py/upstream/fixtures/long_set.py", "package-lock.json"]);
});

test("a directory with many small generated files outranks one with a single larger file", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ filename: `gen/many/f${i}.json`, additions: 10, deletions: 0 }));
  const sample = sampleGenerated([{ filename: "gen/one/big.json", additions: 300, deletions: 0 }, ...many], 1);
  assert.deepEqual(sample, ["gen/many/f0.json"]);
});
