# Architecture

The reviewer is a reusable GitHub Actions workflow, `.github/workflows/review.yml`. A target repository calls it from a small caller workflow (`templates/caller.yml`). Each run reviews one pull request, or answers one command, and exits. It keeps no state outside GitHub: what it needs from earlier reviews is read back from its own review comments.

For the threat model behind these choices, see [security-model.md](security-model.md). For inputs and settings, see [configuration.md](configuration.md).

## Activation

The workflow runs on three events and ignores every other one.

- **Team review request.** Requesting the reviewer team fires `pull_request_target` with action `review_requested` and `requested_team.slug` equal to `team_slug`. The bot reviews once. After every review it removes the team request, so requesting the team again asks for another review: GitHub only clears a team request when a team member reviews, and the team has none. Removing the request does nothing. The bot never requests the team itself and ignores any bot's team request.
- **Top-level comment** (`issue_comment` on a PR) holding a command for the app handle or the team.
- **Reply in one of the bot's finding threads** (`pull_request_review_comment`).

Rules the gate applies:

- Only users with write access to the repository can trigger a run (`GET /repos/{owner}/{repo}/collaborators/{user}/permission`).
- The bot never acts on comments by itself or any other bot.
- Quoted lines and fenced code in a comment are ignored, so quoting a command doesn't fire it again.
- In a finding-thread reply, text after the handle that isn't a command is feedback on that finding. Elsewhere an unknown command gets the help text.
- Commands addressed to the team (`@<org>/<team_slug> review`) count like commands to the app, because people use the team as the bot's name. Any other mention of the team is ignored, with no help reply. `re review` is accepted like `rereview`.
- Draft PRs are reviewed only on an explicit request.
- Pushes do nothing. The workflow's prefilter drops them before any runner starts.
- PR events count only as `pull_request_target`. See [security-model.md](security-model.md#pull_request_target-only).

Concurrency is per job, not per workflow, so an ordinary comment never cancels a review. The review and post jobs share the group `reviewer-<repo>-<pr>` with `cancel-in-progress: true`: a newer request supersedes a running one, and `stop` joins the group to cancel it.

## Jobs

| Job | Credentials | What it does |
|---|---|---|
| gate | `GITHUB_TOKEN` (`pull-requests: read`) | Checks out the reviewer source at `reviewer_ref`, parses the event, checks the trigger and the sender's permission. Outputs a mode: `review`, `rereview`, `help`, `stop` or `skip`. Hands the source and its decision to later jobs as an artifact. |
| review | `GITHUB_TOKEN` (read: contents, pull requests, checks, statuses, actions) for `prepare`; the chosen provider's key in the Claude Code step only | Checks out the PR head as data; `prepare` builds the context bundle; runs Claude Code with the review skill; uploads `findings.json`, the run manifest and the redacted session transcript. |
| post | `GITHUB_TOKEN` (read); an app token for the calling repository with `pull-requests: write`, `contents: read`, `members: read` | Validates `findings.json` against the schema, re-reads PR state, CI, `REVIEW.md` and `CODEOWNERS` from GitHub, applies the verdict policy, posts the review, resolves fixed threads, removes the team request, requests code owners. |
| respond | as post | Answers `help` and `stop`. |
| report-failure | an app token with `pull-requests: write`, `contents: read` | Comments on the PR with a link to the run when review, post or respond fails. |

The review job and the post job are separate so that the job reading untrusted content holds no credential that can write. The model's process holds no GitHub token at all; `prepare` fetches everything it needs first.

## Context bundle

`prepare` writes, before the model starts:

- the diff and commits against the merge base, and a worktree at the merge base;
- the PR description;
- CI state, with the log tail of each failed job;
- the bot's prior findings, with the replies on their threads, and any feedback;
- `skill/review/team-context.md`, the bar shared by every repository;
- the repository's `REVIEW.md`, `CLAUDE.md`, `AGENTS.md` and `CODEOWNERS` **from the base branch**, so a PR can't rewrite the bar it is judged by.

It deletes `.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `AGENTS.override.md` at any depth in both trees, since a PR controls them. It also deletes every symlink in both trees. The diff still shows each link's target as text, and the manifest lists what was removed.

**Written code first.** `diff.patch`, `diffstat.txt` and `delta.patch` cover only files people wrote. Generated and lock files (`generatedPaths` plus the lock-file defaults) go to `generated-diffstat.txt`, with the first 60 patch lines of up to 8 of them in `generated-sample.patch` (the largest file in each of the directories with the most changed lines). This keeps a PR with a large generated or vendored diff within the model's context and the run's budget. Specialists are chosen from the written files only. The trade-off: hand-written code placed under a `generatedPaths` directory is seen only if the sample or the listing gives it away. `generatedPaths` comes from the base branch, so a PR can't widen it.

## Claude Code invocation

`scripts/run-claude.sh` runs, in the `work/` directory:

```bash
claude -p "$(cat context/prompt.md)" \
  --restricted --strict-mcp-config \
  --permission-mode dontAsk --permission-prompts none \
  --allowedTools "Read,Grep,Glob,Agent" \
  --disallowedTools "Edit,Write,NotebookEdit,WebFetch,WebSearch,ScheduleWakeup" \
  --agents agents.json \
  --append-system-prompt "$(cat skill/review/SKILL.md)" \
  --json-schema "$(cat schema/findings.schema.json)" \
  --output-format stream-json --verbose --forward-subagent-text \
  --no-session-persistence \
  --model "$MODEL" --max-budget-usd "$MAX_BUDGET_USD"
```

- **No shell, no network tools.** `--restricted` removes Bash and the other code-running tools and WebFetch, ignores settings files (so a PR's `.claude/settings.json` can't add hooks), and confines file tools to the working directory. `--strict-mcp-config` loads no MCP servers. Anything not pre-approved is denied, never asked.
- **No builds or test suites.** CI already ran them; the bundle has the results. Claims only a local run could settle are marked `needsRun`.
- **No writes.** The only output is the structured result, which the poster validates and sanitises.
- **Subagents run in the foreground** (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), so each Agent call returns its report and the session ends when the review does.
- **Subagents** come from `agents/`: ECC reviewer agents, vendored unchanged, given read-only tools and a note that there is no shell.
- **The skill** is passed as a system prompt addition, so CI doesn't depend on skill discovery. `skill/review/` is still a normal skill for local use.
- **One credential.** The step gets only the chosen provider's key; `run-claude.sh` checks the provider, key and region pairing and unsets the other provider's variables.

The session is streamed to the step log, and written to `transcript.jsonl` (raw) and `transcript.md` (readable). A separate step redacts both, also when the review fails or times out, and uploads them as the `reviewer-transcript` artifact for 14 days. If redaction fails, neither file is uploaded.

## The review skill

The skill (`skill/review/SKILL.md`) builds on the ECC `code-reviewer` agent and doesn't redefine how to review. Its steps:

1. **Context.** Read the PR body and commits, the diff against the merge base, `team-context.md`, the repository's `REVIEW.md`, prior findings and, for a re-review, the feedback.
2. **Fan out with subagents.** `code-reviewer` always runs. Specialists are picked from the changed paths: `typescript-reviewer` for `.ts`/`.tsx`, `rust-reviewer` for `.rs`, `python-reviewer` for `.py`; `security-reviewer` when the diff touches auth, credentials, input parsing, the filesystem or the network; `silent-failure-hunter` when it changes error handling. Each agent gets the same context bundle.
3. **Verify.** Re-read every candidate finding at its cited line at the head SHA. Drop anything that can't be confirmed. Mark claims that only a local run could settle `needsRun`.
4. **Deduplicate and grade.** Merge overlapping findings and assign a level.
5. **Re-review only.** Give each earlier finding a status of `fixed`, `open` or `moot`, with evidence, and review only the delta since the last reviewed SHA plus anything the feedback reopens.
6. **Emit `findings.json`.** The skill posts nothing itself.

The skill reviews code, tests, behavioural config and workflows in full, checks the generated sample against the description, and reads only a few hunks of data files that aren't listed as generated (goldens, fixtures, tables, licence texts), suggesting a `generatedPaths` line when they dominate. It rates risk by how likely the change is to break something for users; migrations, CI and deployment, packaging and release, and auth are high.

## Finding levels

| Level | Meaning | Effect on the verdict |
|---|---|---|
| **blocker** | A bug, security hole or data loss on a touched path; a regression against the base; or a breach of the repository's `REVIEW.md` bar | Any blocker means `REQUEST_CHANGES` |
| **follow-up** | Real, but safe to merge and fix later: maintainability, a missing test (a blocker only when `REVIEW.md` makes it one), an inaccurate PR description | Doesn't block |
| **nit** | Wording, naming, small cleanups | Doesn't block. At most 5 are posted; the rest are counted in the summary |

## findings.json

`schema/findings.schema.json` (JSON Schema draft-07, which `claude --json-schema` accepts) describes the model's output and nothing else. Run metadata (PR, head SHA, merge base, mode, scope) comes from the gate and `prepare`, never from the model.

```json
{
  "risk": { "level": "low|medium|high", "reasons": ["…"] },
  "summary": "…",
  "findings": [
    { "id": "B1", "level": "blocker", "path": "src/x.ts", "line": 42, "endLine": 44,
      "title": "…", "evidence": "…", "fix": "…", "confidence": "high", "needsRun": false }
  ],
  "priorFindings": [ { "id": "B1", "status": "fixed|open|moot", "evidence": "…" } ],
  "escalate": { "needed": true, "reason": "…", "paths": ["native/src/…"] },
  "ci": { "state": "pass|fail|pending", "notes": "…" },
  "reviewMdSuggestions": ["…"]
}
```

`confidence` is `high` or `medium`. Code owners are resolved by the poster, not carried on findings. The poster renumbers a new finding whose id collides with a prior one or doesn't match its level.

## Verdict and approval policy

The model reports findings, risk and escalation. The **poster derives the verdict** from them and the rules below (`poster/src/policy.ts`). The model has no verdict field, so it can neither hold back an approval its findings don't justify nor approve past them.

| Condition | Posted review |
|---|---|
| Any blocker | `REQUEST_CHANGES` |
| No blocker, and every low-risk rule holds | `APPROVE` |
| Otherwise | `COMMENT`, and escalate if needed |

**Low-risk rules**, all required:

- approvals are switched on for the repository (`allow_approve` in the caller);
- no blockers, new or prior and still open, and no `needsRun` findings;
- CI is green at the head SHA, not counting the reviewer's own run; no checks at all doesn't count as green;
- the diff touches no high-risk path: `.github/`, `REVIEW.md` and `CODEOWNERS` always, plus those listed in `REVIEW.md`. Issue and pull request templates (`.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE/`, `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`) are outside the built-in `.github/` entry, since no workflow runs them; a repository that wants them high-risk lists them in `REVIEW.md`;
- the PR isn't from a fork and isn't authored by a bot;
- the head hasn't moved since the reviewed SHA, and the review wasn't summary-only.

When a PR isn't approved, the summary says which rules failed. The model's `risk.level` is not a rule; it drives escalation only. Anything that must stop a merge is a blocker. There is no size limit on approvals.

If the settings block in `REVIEW.md` doesn't parse, approval is off and the summary says why.

Bot approvals count toward required reviews in branch protection and rulesets. So these rules are a security boundary, and changes to them or to anything that feeds them (the poster, the schema, `REVIEW.md` parsing) deserve a second human's review.

## Escalation

The bot escalates when any of these holds:

- a blocker sits on a path with an owner;
- `risk.level` is `high`;
- the model sets `escalate.needed`, for example when a finding needs a design decision.

The poster resolves `CODEOWNERS` for the relevant paths (the last matching pattern wins, as on GitHub), requests those users and teams as reviewers, and mentions them in the summary with a one-line reason. It never requests the PR author, and never re-requests someone who has already reviewed the current head. It reads `CODEOWNERS` from `.github/`, the root or `docs/`, on the base branch. If there is none, it mentions the repository admins instead and flags the missing file as a follow-up.

## Re-review

- Only on request: `review`, `rereview <feedback>`, a reply in a finding thread, or requesting the team again. A push never starts one.
- The re-review covers the commits since the last reviewed SHA. That SHA and the open and moot findings are stored in a hidden marker in the bot's summary: `<!-- reviewer:state {"v":1,"sha":…,"findings":[…]} -->`. Each inline comment carries `<!-- reviewer:finding <id> -->`, which ties its thread to the finding.
- **Fixed findings:** the poster replies "Fixed in `<sha>`" and resolves the thread.
- **Still-open findings** stay open and are restated in the new summary.
- **Same head again:** a `review` or team request on a head already reviewed re-checks the earlier findings and any feedback, with no fresh fan-out, so the same code doesn't collect new findings on each pass. `review full` asks for a fresh pass.
- **Force-pushes:** if the old SHA is no longer an ancestor of the head, the bot falls back to a full review and says so.

## Feedback

Feedback is a `rereview <text>` comment, or a reply mentioning the handle in one of the bot's finding threads. Either one starts a re-review with the feedback as input.

- **"Intentional" or "won't fix: <reason>"** on a finding: the bot marks it `moot` with that reason, and keeps it out of later reviews unless the code changes again.
- **"Wrong, because …":** the bot re-verifies against the code, then withdraws the finding or explains why it stands.
- **Feedback that shows a gap in the repository's bar:** the summary suggests a `REVIEW.md` line. The bot never edits the file.

## Output format

- **One review per run, posted atomically:** the verdict, a summary body and inline comments.
- **Summary body:**
  - a tally line, for example `2 blockers · 3 follow-ups · 1 nit`;
  - the verdict and why;
  - escalations;
  - every finding the tally counts, listed by level (Blockers, Follow-ups, Nits), one line each with its location: earlier findings still open first, then new ones. Lists, not a table, because GitHub squeezes tables into narrow columns;
  - on a re-review, earlier findings that were fixed or no longer apply, with evidence, in a collapsed "Resolved since the last review" block;
  - CI state;
  - the hidden state marker.
- **Inline comments:** `**[blocker] Title**`, then the evidence, the fix, and the `needs-run` flag when it applies.
- **Findings on lines outside the diff** go into the summary under "Additional findings".
- No inline comment repeats what CI already reports.

## Approvals and pushes

The bot's approval stays through later pushes, like a human approval in a repository that doesn't dismiss stale approvals: a merge commit from the base branch or a small follow-up commit shouldn't cost the approval. The approval is recorded on the commit it reviewed, and the summary names that commit. Only a newer review from the bot that isn't an approval, or `stop`, withdraws it. This is an accepted risk; see [security-model.md](security-model.md#accepted-risk-approvals-survive-pushes).
