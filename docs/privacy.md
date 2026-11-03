# Privacy: what leaves your repository

Reviewer runs entirely in your own GitHub Actions, with your own secrets. This page lists what leaves your repository
during a review, where it goes, and who can see it. Each claim names the file that does it.

## Nothing goes to Nera

The workflow sends nothing to Nera Software: no telemetry, no usage data, no copy of the code or the review. It talks
to GitHub and the model provider you choose, and, only if you turn it on, to a Rerail remote you name
([below](#to-a-rerail-remote-only-if-you-turn-it-on)). Nera's part is the code in this repository, which your
caller workflow loads at the tag you pin ([docs/versioning.md](versioning.md)).

## To the model provider

The `review` job runs Claude Code ([scripts/run-claude.sh](../scripts/run-claude.sh)) against the provider set by your
caller's `provider` input ([.github/workflows/review.yml](../.github/workflows/review.yml)):

| `provider` | Service | Credential |
| --- | --- | --- |
| `anthropic` | The Claude API | Your secret `REVIEWER_ANTHROPIC_API_KEY` |
| `bedrock` | Amazon Bedrock, in the region of your `aws_region` input | Your secret `REVIEWER_BEDROCK_API_KEY` |

Only the chosen provider's key reaches the step; `run-claude.sh` unsets the other. The data goes under your own
account, so the provider's terms and your agreement with it govern retention and use. Nera has no access to it.

What the model can read, and so what may be sent to the provider:

- the pull request head and the merge base, checked out in the runner (`work/pr/`, `work/base/`), with agent
  configuration files such as `.claude/`, `CLAUDE.md` and `AGENTS.md` and all symlinks removed first
  ([poster/src/prepare.ts](../poster/src/prepare.ts));
- the context bundle `prepare.ts` builds with the job's read-only `GITHUB_TOKEN`: the diff, the commit messages, the
  pull request's title, description and labels, your `REVIEW.md`, `CLAUDE.md`, `AGENTS.md` and `CODEOWNERS` as on the base branch, the CI state at the head with the
  last lines of failed job logs, the reviewer's earlier findings and the replies in their threads, and a sample of generated files;
- the reviewer's own prompts and agent definitions ([skill/](../skill/), [prompts/](../prompts/),
  [agents/](../agents/)).

The model uses file tools to read the checkouts, so any file in the repository at those two commits may be sent, not
only the changed ones. It has no shell, no network tools and no GitHub token (`run-claude.sh`), so it cannot fetch
anything else.

## To a Rerail remote, only if you turn it on

Rule-aware review and the scheduled scan ([rerail.md](rerail.md)) run Rerail in your runner and keep its result in
your Actions run. Nothing goes anywhere else unless the caller sets `send_results: true` and passes the secrets
`RERAIL_REMOTE_URL` and `RERAIL_REMOTE_TOKEN`. Then a separate `send` job, holding only those two secrets, posts one
batch per scan to that URL ([poster/src/rerail.ts](../poster/src/rerail.ts)). Exactly this is sent:

- a header naming the sender: `github-actions:<owner>/<repo>`, a UUID derived from it, the Rerail version, a batch id
  and the time;
- the scan result (`rerail.scan/1`): scan id, start and end times, the repository's key and name, the runner's
  checkout path, head SHA and ref, the scope, the base ref and merge base, the paths scanned; each rule's id, content
  hash, mode and source (pack id or ref); each violation's rule id, mode, code, clause, path, start and end line and
  column, the rule's message and a fingerprint (a hash, no code text); failures with their messages; the counts.

The result holds no source code, diff, PR text, model output or credential. Rule messages are the rule authors'
text. Who can read the data at the remote is up to whoever runs it.

Installing Rerail fetches it from where the caller says: `RERAIL_PACKAGE_URL`, the npm registry or a URL in
`rerail_package`, or, for `rerail_package: remote:<version>`, the Rerail remote, which then sees the token, the
version and the runner's address. Nothing about the repository is sent to fetch it.

## To your Actions run

These stay in your repository, visible to whoever can read its Actions runs. For a public repository that is anyone.

- **The step log** of the `review` job prints the session as it happens: the model's text, each tool call with its
  input, and the start of each tool result, which can quote your code (`run-claude.sh`). GitHub masks secret values in
  the log.
- **The `reviewer-transcript` artifact** holds the full session (`transcript.md` and `transcript.jsonl`), kept 14 days
  (`review.yml`). It is not masked like the log, so before upload the poster replaces known credential formats
  (Claude API keys, GitHub tokens, private keys, Bedrock and AWS keys) with `[redacted]`
  ([poster/src/text.ts](../poster/src/text.ts)). If redaction fails, the transcript is deleted rather than uploaded.
- **The `reviewer-bundle` and `reviewer-findings` artifacts** pass the reviewer's code, the gate decision and the
  findings between jobs, kept 3 days.
- **The job summary** records the result, turns, duration and cost of the session.
- **The `reviewer-rules` artifact** (rule-aware review, kept 3 days) and **the `rerail-scan` artifact** (scheduled
  scan, kept 30 days) hold the Rerail scan results described above.

## To the pull request

The `post` job posts the review on the pull request as the GitHub App you configured: a summary, inline comments on
findings, and a verdict. Anyone who can read the pull request can read it. Model output is sanitized before it is
posted: it cannot mention people, load remote images, or forge the reviewer's state, and known credential formats are
redacted ([poster/src/text.ts](../poster/src/text.ts)).

## Controlling it

- Choose the provider and model, and scope the key to invoking that model only.
- Lower the transcript's exposure by restricting who can read Actions in your repository; a public repository's runs
  are public.
- Delete a run's artifacts and logs from the Actions page at any time.
