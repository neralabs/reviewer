# Security model

The reviewer reads code that anyone who can open a pull request controls, and it posts reviews whose approvals can count toward a repository's required reviews. This document states what it protects, what it assumes, and how each part is defended. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is protected

- **Write access to the target repository.** The app token can post reviews and comments, approve, and request reviewers. An approval can satisfy a required-review rule.
- **The model credential.** A Claude API key or an Amazon Bedrock API key, which spends money.
- **The app's private key.** It can mint tokens for every repository the app is installed on.
- **Other secrets of the calling repository.** The reviewer must not see them.

## Assumptions

- Everything in a pull request is untrusted: code, file names, symlinks, the description, commit messages, comments and review replies. So is everything the model produces, since the PR can steer it.
- The base branch of the target repository is trusted. Its caller workflow, `REVIEW.md` and `CODEOWNERS` define how the PR is judged.
- The reviewer source at the ref the caller pins is trusted. Whoever can change it controls what runs with the caller's secrets.
- People with write access to the target repository are trusted to trigger reviews.

## Untrusted PR content

The PR is checked out as data and never executed: no install, build, test or script from the PR runs. CI has already run those, and the bundle carries its results.

The model reads the PR, so the model is treated as compromised by it. It runs with:

- **no shell and no network tools.** Claude Code's `--restricted` mode removes Bash and other code-running tools and WebFetch, and confines file tools to the working directory; `--disallowedTools` also removes edits and web search; `--strict-mcp-config` loads no MCP servers; `dontAsk` denies anything not pre-approved;
- **no GitHub token.** `prepare` fetches everything the model needs before it starts. The only secret in the process is the model credential;
- **no output channel but `findings.json`.** It can't post, push or comment.

See [architecture.md](architecture.md#claude-code-invocation) for the exact invocation.

## Scrubbed configuration files and symlinks

A PR could add files that Claude Code loads as configuration or instructions. `prepare` deletes `.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `AGENTS.override.md` at any depth in both the PR tree and the merge-base tree. `--restricted` also ignores settings files, so a PR's `.claude/settings.json` can't add hooks or environment variables.

A PR could add a symlink such as `x -> /proc/self/environ` to point the model's file tools at the review job's environment, which holds the model credential. `prepare` deletes every symlink in both trees without following it. Claude Code also refuses to read through a link that leaves the working directory; the deletion doesn't rely on that. The diff still shows each link's target as text.

## Base-branch REVIEW.md and CODEOWNERS

The repository's `REVIEW.md`, `CLAUDE.md`, `AGENTS.md` and `CODEOWNERS`, and the settings block in `REVIEW.md` (high-risk paths, generated paths, large-PR threshold), are read from the base branch, never from the PR. A PR can't lower the bar it is judged by, hide its own files as generated, or change who gets escalations. The poster re-reads `REVIEW.md` and `CODEOWNERS` from GitHub itself rather than trusting the review job's copy.

Changes to `.github/`, `REVIEW.md` and `CODEOWNERS` are always high-risk, so the bot never approves them.

## Output sanitisation and redaction

The poster validates `findings.json` against the schema, then passes every model string it posts through one sanitiser: the summary, findings, earlier findings' evidence (including the "Marked moot" thread reply), the escalation and risk reasons, and suggested `REVIEW.md` lines. It:

- neutralises `@` mentions, so only the poster's own escalation pings anyone;
- escapes images, since GitHub would fetch their URLs;
- escapes every `<` and every backtick outside code, so there is no raw HTML and no backtick can re-pair GitHub's code spans to expose text taken for code;
- escapes HTML comments, so nothing can forge the hidden state marker;
- accepts a fence only when GitHub is sure to read it as one, and otherwise escapes it like prose;
- shows a finding's `path`, or an escalation path, only if it is a changed file or made of ordinary path characters (`[\w.@/+-]`), else as `(invalid path)`, and puts paths in code spans sized to hold any backtick;
- redacts anything shaped like a credential: Anthropic and GitHub tokens, private keys, Bedrock API keys, AWS access key IDs and secret access keys.

The verdict is not model output. The poster derives it from the findings and fixed rules ([architecture.md](architecture.md#verdict-and-approval-policy)), and it re-reads PR state and CI from GitHub, so a stale or forged claim in `findings.json` can't earn an approval.

## Transcript visibility

The review job uploads the Claude Code session as the `reviewer-transcript` artifact for 14 days. It contains the reviewed code and the model's reasoning, so it is as visible as the repository's Actions artifacts: for a public repository, public. GitHub masks registered secrets in step logs but not in artifacts, so a separate step redacts credentials in the transcript before upload, also when the review fails or times out. If redaction fails, the transcript is not uploaded. See [privacy.md](privacy.md) for what is sent to the model provider and kept.

## Fork handling

- Team requests on fork PRs are ignored.
- Replies in finding threads on fork PRs are ignored: GitHub gives `pull_request_review_comment` runs from forks no secrets. A top-level `rereview` comment works instead.
- A top-level comment command from someone with write access reviews a fork PR. The model reads the fork's code but never runs it.
- Fork PRs are never approved.

## pull_request_target only

PR events are accepted only as `pull_request_target`, which runs the caller workflow from the base branch. On `pull_request`, GitHub runs the PR's own copy of the caller, so a PR could rewrite its reviewer configuration (turn approvals on, point at another reviewer ref) and approve itself. The gate ignores `pull_request`. `pull_request_target` is safe here only because nothing from the PR is executed; keep it that way in any change to the workflow.

## Per-job scoped app tokens

The workflow sets `permissions: {}` at the top and grants each job only what it needs. The gate and review jobs use the read-only `GITHUB_TOKEN`. Jobs that write mint their own short-lived app token, scoped to the calling repository: `pull-requests: write`, `contents: read`, and `members: read` where the job changes team review requests. No token can push code. The model credential reaches only the Claude Code step, and only the chosen provider's key does.

Give the app no permission beyond those listed in the [quickstart](../README.md#quickstart), and scope the model key to invoking the configured model only. [infra/bedrock.yml](../infra/bedrock.yml) shows this for Bedrock.

## Explicit secrets, not inherit

The caller passes each secret by name. `secrets: inherit` would hand the reviewer every secret the calling repository can see, including unrelated deploy or release keys, so a compromise of the reviewer source would expose all of them.

## Pin a release tag

A caller runs whatever the reviewer ref it names contains, with its secrets. Pin `uses:` and `reviewer_ref` to a release tag (or a commit SHA), not a branch, and keep them equal: the reusable workflow can't see its own ref, so `reviewer_ref` tells it which source to load. See [versioning.md](versioning.md).

## Accepted risk: approvals survive pushes

The bot's approval stays through later pushes, like a human approval in a repository that doesn't dismiss stale approvals. An approval can therefore stand on code the bot never saw. The approval is recorded on the commit it reviewed, and the summary names it. Callers that need otherwise should require approval of the most recent push in their branch protection or ruleset, or dismiss stale approvals on push.

## Other limits

- Generated paths are only sampled. Hand-written code placed under a `generatedPaths` entry is seen only if the sample or the listing gives it away. `generatedPaths` comes from the base branch.
- The reviewer can be wrong. It is one reviewer, not a replacement for code owners on high-risk changes, which it never approves.
