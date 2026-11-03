# Modules

A module is a deterministic check that runs beside the review: a linter, a rule engine, a policy scanner. Modules
need no model, and a module that fails never blocks the review. The core of the reviewer knows nothing about any one
module. It hands each the same inputs, reads back one common result, and treats every module the same way.

Two places use module results:

- **In a pull request review**, the modules run in **diff mode**, in parallel with the review. The review (the first
  pass) never sees their output. Afterwards a second, smaller model step, the **rules pass**, reads the review's
  findings and the modules' *new* findings. It recommends what to add, what overlaps a finding the review already has,
  and what is a false positive. The poster merges both into one review; findings from the rules pass are labelled.
- **In a scheduled or manual run** (scan mode), the modules run in **repository mode** over the whole branch. No model
  runs. The results are kept as the run's `reviewer-modules` artifact and can be sent to a results sink.

Turn modules on in the caller with `modules: <id> <id>…` and each module's own inputs
([configuration.md](configuration.md)). This repository ships one module, [Rerail](rerail.md).

## The contract

A module lives in `modules/<id>/`: an id of lower-case letters, digits and `-`. The reviewer runs
`modules/<id>/run.sh` with bash, in the checkout, with these variables:

| Variable | What it is |
| --- | --- |
| `MODULE_MODE` | `diff` (a pull request) or `repository` (a whole branch) |
| `MODULE_CHECKOUT` | The code to check: the pull request's head, or the branch |
| `MODULE_BASE_CHECKOUT` | A checkout of the base branch's tip (diff mode), or the branch itself (repository mode). **The only place to take configuration from**: rules, allow-lists, settings. Never from `MODULE_CHECKOUT`, which the pull request controls |
| `MODULE_BASE_SHA` | That checkout's commit |
| `MODULE_MERGE_BASE` | The merge base of the pull request (diff mode); the branch's head (repository mode) |
| `MODULE_HOME` | An empty directory for the module's own state (tools, caches, homes) |
| `MODULE_OUT` | Where to write the result |

Module inputs reach `run.sh` as environment variables too. A module that needs a new caller input or secret adds it
to `.github/workflows/review.yml`.

A module writes `$MODULE_OUT/results.json`:

```json
{
  "schema": "reviewer.module-results/1",
  "module": "todo",
  "version": "1",
  "mode": "diff",
  "status": "completed",
  "checks": [{ "id": "no-todo", "level": "note" }],
  "findings": [
    {
      "module": "todo", "checkId": "no-todo", "level": "note",
      "path": "src/a.ts", "start": { "line": 3, "column": 1 }, "end": { "line": 4, "column": 1 },
      "message": "Resolve the TODO, or track it.",
      "fingerprint": "5f0c…", "state": "new"
    }
  ]
}
```

- `checks` lists every check the module ran. A finding may only cite one of them.
- `level` is `error`, `warning` or `note`. A **new** `error` or `warning` is a blocker; a `note` is a follow-up at
  most. The rules pass may lower a level, never raise it.
- Positions are 1-based; `end` is exclusive.
- `fingerprint` is stable when lines move (for example a hash of the check, the path and the matched text), plain
  (letters, digits, `:`, `_`, `-`), and unique within the result. Re-reviews use it to tell fixed from still open.
- `state` is `new` when the change brought it in, `existing` when the merge base had it already. Existing findings
  are never posted on a pull request. In repository mode everything is `existing`.
- On failure, write `"status": "failed"` with an `error`, or just exit non-zero.

[schema/module-results.schema.json](../schema/module-results.schema.json) has the full schema. The reviewer checks
every result against it: a result that breaks it counts as failed as a whole, and the review goes on without it.

Optionally, a module also writes:

- `$MODULE_OUT/raw/`: its own output, kept in the run's artifact;
- `$MODULE_OUT/sink.json`: a list of records, each with a `type` and an `id`, for the results sink (below).

## Writing a module

The example the reviewer's tests run (`poster/test/fixtures/modules/todo/run.sh`): a note for every line with `TODO`,
new when the merge base doesn't have that line.

```bash
#!/usr/bin/env bash
# Example module "todo" (docs/modules.md): a note for every line with TODO in the checkout. A finding is new
# when the merge base has no such line in that file. Deterministic: no network, no model, no secrets.
set -euo pipefail
cd "$MODULE_CHECKOUT"
findings=""
while IFS= read -r match; do
  path="${match%%:*}" rest="${match#*:}"
  line="${rest%%:*}" text="${rest#*:}"
  fingerprint="$(printf '%s\n%s' "$path" "$text" | git hash-object --stdin)"
  state=existing
  if [ "$MODULE_MODE" = diff ] && ! git grep -qF -e "$text" "$MODULE_MERGE_BASE" -- "$path" 2>/dev/null; then state=new; fi
  findings+="${findings:+,}{\"module\":\"todo\",\"checkId\":\"no-todo\",\"level\":\"note\",\"path\":$(jq -Rn --arg p "$path" '$p'),"
  findings+="\"start\":{\"line\":$line,\"column\":1},\"end\":{\"line\":$((line + 1)),\"column\":1},"
  findings+="\"message\":\"Resolve the TODO, or track it.\",\"fingerprint\":\"$fingerprint\",\"state\":\"$state\"}"
done < <(git grep -n -I -e TODO HEAD -- . | sed 's/^HEAD://' || true)
cat >"$MODULE_OUT/results.json" <<EOF
{"schema": "reviewer.module-results/1", "module": "todo", "version": "1", "mode": "$MODULE_MODE", "status": "completed",
 "checks": [{"id": "no-todo", "level": "note"}], "findings": [$findings]}
EOF
```

To add a module:

1. Add `modules/<id>/run.sh`, and a `module.json` naming its inputs.
2. Take configuration only from `MODULE_BASE_CHECKOUT`. Write state only under `MODULE_HOME` and `MODULE_OUT`.
3. Run nothing from the checkout: a module reads the code, it doesn't execute it.
4. Add tests next to it (`modules/<id>/test/`); `npm test` in `poster/` runs them.

## The results sink

With `send_results: true` and the secrets `RESULTS_SINK_URL` and `RESULTS_SINK_TOKEN`, a separate `send` job posts
the modules' `sink.json` records to `<RESULTS_SINK_URL>/v1/batches` with `Authorization: Bearer <token>`. It sends
one NDJSON batch: a header line, then the records.

- **Header:** `{"type":"batch","protocol":1,"batchId","machineId","machineLabel","rerailVersion","sentAt"}`.
  - The machine is the calling repository's GitHub Actions: `machineLabel` is `github-actions:<owner>/<repo>`, and
    `machineId` is a UUID derived from it. Give each calling repository its own token.
  - `batchId` is derived from the repository, run, attempt and kind of run, so a retried send is stored once.
  - `rerailVersion` is the version of the first module that sent records.
- **Retries:** server errors, rate limits and timeouts are retried with backoff. A `401`, `413` or other `4xx` stops
  the send at once. No message includes the URL or the token.
- **What the job holds:** only those two secrets. No model key, no GitHub token, and nothing a model wrote.
- **Failures:** a failed send doesn't affect the review.
