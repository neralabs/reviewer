# Review bar for <repo>

The reviewer reads this file from the base branch on every review, on top of the team-wide bar in neralabs/reviewer (`skill/review/team-context.md`). Write it for a reviewer who is new to this repo. Changes to it are changes to what blocks a merge, so review them like code.

## What this repo is

One paragraph: what it ships, who depends on it, and what breaking it costs.

## What blocks a merge here

Repo-specific rules that add to the team-wide blocker list. Examples:

- Every new lint rule ships with a fixture that fails without it.
- Public API changes in `packages/sdk/` need a changeset.
- No `unwrap()` on paths reachable from user input in `native/src/`.

## Known gaps

Things reviewers should not re-report as new findings, with the ticket that tracks each:

- `legacy/` has no tests (ABC-123).

## High-risk areas

Where a mistake costs the most, and what to look for there:

- `native/src/engine/`: the engine core. Check allocation in hot loops and panics.
- `migrations/`: irreversible. Check every migration has a down path.

## Reviewer settings

Machine-readable. Paths use CODEOWNERS syntax and add to the defaults. A PR touching a high-risk path is never auto-approved. `generatedPaths` lists files nobody writes by hand (generated code, snapshots, goldens, vendored upstream data, licence texts): the reviewer sees only a listing and a small sample of them, so its budget goes on the written code. `largePrLines` (optional) sets the changed-line count above which the review is summary-only, overriding the default of 50,000; generated paths don't count toward it. If this block doesn't parse, approval is off and the review says why.

```json reviewer
{
  "highRiskPaths": ["native/src/engine/", "migrations/", ".github/workflows/"],
  "generatedPaths": ["**/generated/", "*.snap"],
  "largePrLines": 50000
}
```
