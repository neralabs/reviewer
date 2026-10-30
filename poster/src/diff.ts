import { matchesAny } from "./patterns.ts";

/** Lines on the head side of a unified diff patch that GitHub accepts inline comments on (added and context lines). */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let next = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0 || line.startsWith("\\")) continue;
    if (line.startsWith("-")) continue;
    if (line.startsWith("+") || line.startsWith(" ")) {
      lines.add(next);
      next++;
    }
  }
  return lines;
}

export interface ChangedFile {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface DiffSize {
  lines: number;
  files: number;
  excludedFiles: string[];
}

/** Changed lines and files, not counting generated and lock files. */
export function diffSize(files: readonly ChangedFile[], generated: readonly string[]): DiffSize {
  const excludedFiles = files.filter((f) => matchesAny(f.filename, generated)).map((f) => f.filename);
  const excluded = new Set(excludedFiles);
  const counted = files.filter((f) => !excluded.has(f.filename));
  return {
    lines: counted.reduce((sum, f) => sum + f.additions + f.deletions, 0),
    files: counted.length,
    excludedFiles,
  };
}

/**
 * Generated files to show the model a slice of: the largest file in each of the directories with the most
 * changed lines, one per directory, so a few files stand for each kind of generated change (a goldens table,
 * a fixture, a licence) instead of the model reading all of them.
 */
export function sampleGenerated(files: readonly ChangedFile[], max: number): string[] {
  const byDir = new Map<string, { lines: number; largest: ChangedFile }>();
  for (const f of files) {
    const dir = f.filename.includes("/") ? f.filename.slice(0, f.filename.lastIndexOf("/")) : "";
    const lines = f.additions + f.deletions;
    const group = byDir.get(dir);
    if (!group) {
      byDir.set(dir, { lines, largest: f });
      continue;
    }
    group.lines += lines;
    if (lines > group.largest.additions + group.largest.deletions) group.largest = f;
  }
  return [...byDir.entries()]
    .sort(([da, a], [db, b]) => b.lines - a.lines || da.localeCompare(db))
    .slice(0, max)
    .map(([, g]) => g.largest.filename);
}
