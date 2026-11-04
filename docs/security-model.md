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

Changes to `.github/`, `REVIEW.md` and `CODEOWNERS` are always high-risk, so the bot never approves them. The one exception is a dependency bot's PR that passes the guards below. Even then, `REVIEW.md`, `CODEOWNERS`, `.github/dependabot.yml` and a bump of the reviewer itself never pass.

## Dependency PRs

A repository can list dependency bots in `REVIEW.md` `dependencyUpdates` (base branch only). Their PRs are reviewed when CI finishes, without anyone asking, and they can be approved even though they touch manifests, lock files and workflows. That approval counts toward branch protection, so it rests on checks the PR's content can't steer:

- **Who wrote every commit.** Every commit's GitHub author is a listed bot, and its committer is that bot or GitHub's `web-flow` with a verified signature. A person who pushes to a Dependabot branch turns the exemption off for that PR. GitHub links a commit author only from the identity behind the push: a bot can't set it by choosing an email address, and an unlinked author fails the check.
- **What changed.** The PR may change only lock files, `pinFiles`, and manifests and workflows whose diff is version strings and SHAs alone. A dependency bot that has been compromised, or a Dependabot PR someone edited, can't add an install script, a dependency, a workflow step or a reviewer bump and still be approved.
- **Everything else still holds:** approvals on, no blockers, CI green at the head, not a fork, head unchanged since the review, a full review, and no `needsRun` findings except ones that restate a declared CI gap.
- **The verdict stays with the poster.** The model never decides that a PR is a dependency PR or that the guards hold. Release notes, changelogs and the PR description are written by whoever controls the dependency, and the model treats them as data.

What the guards can't see is the dependency's own code. A malicious release that keeps its version-bump shape passes them. The review looks at the lock files for new install scripts, packages from other registries, new transitive packages and changed publishers. CI builds and tests the release, and the caller decides whether to auto-merge. Planned follow-up: deterministic lock-file checks (a package newly marked `hasInstallScript`, a `resolved` or `source` URL outside the default registry) as further guards.

Secrets: GitHub gives a run started by Dependabot only Dependabot secrets. Its docs say so for `pull_request`, `push` and the review events, and say nothing about a `workflow_run` started by a Dependabot run. Store the reviewer's secrets (the app key and the model key) as Dependabot secrets too, under the same names. The gate logs the run's actor and triggering actor, so a missing secret can be traced.

## Modules and the rules pass

- **No bias:** module output never reaches the review's first pass, not in its prompt, bundle or earlier findings.
  The rules pass is a separate job that reads only the review's findings and the modules' new findings.
- **The rules pass is read-only:** it has `Read` alone, over its two input files, and no shell. Module messages come
  from rule files in the repository, so they are data to it, not instructions.
- **The merge is deterministic:** location, check and level cap come from the module's result, never from the
  model, and the review's own findings are never changed or dropped ([architecture.md](architecture.md#modules-and-the-rules-pass)).
- **Configuration from the base branch only:** a module gets a checkout of the base branch's tip and takes its
  configuration only from there. The Rerail module approves rules and repository packs from that checkout alone,
  through Rerail's normal approval. Pack paths resolve inside that checkout, and a path or symlink leading out of it
  fails the module ([rerail.md](rerail.md)).
- **No keys:** modules run in a job with a read-only token (not persisted) and their own inputs; for Rerail, a
  package URL, and the results sink's token only during its install, unset before `npm` runs. They read the pull
  request's files and never run them.
- **Every result is checked:** paths, ids and fingerprints must be plain, and a result that breaks the contract counts
  as failed as a whole.
- **The results sink** gets only the modules' records, from a job holding only its URL and token.

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

PR events are accepted only as `pull_request_target` (and `workflow_run`, below), which runs the caller workflow from the base branch. On `pull_request`, GitHub runs the PR's own copy of the caller, so a PR could rewrite its reviewer configuration (turn approvals on, point at another reviewer ref) and approve itself. The gate ignores `pull_request`. `pull_request_target` is safe here only because nothing from the PR is executed; keep it that way in any change to the workflow. `workflow_run` likewise runs the caller from the default branch. The gate takes only the run's PR number and head SHA from it, re-reads the PR from the API, and reviews only a listed dependency bot's PR.

## Per-job scoped app tokens

The workflow sets `permissions: {}` at the top and grants each job only what it needs. The gate and review jobs use the read-only `GITHUB_TOKEN`. Jobs that write mint their own short-lived app token, scoped to the calling repository: `pull-requests: write`, `contents: read`, and `members: read` where the job changes team review requests. No token can push code. The model credential reaches only the Claude Code step, and only the chosen provider's key does.

Give the app no permission beyond those listed in the [quickstart](../README.md#quickstart), and scope the model key to invoking the configured model only. [infra/bedrock.yml](../infra/bedrock.yml) shows this for Bedrock.

## Explicit secrets, not inherit

The caller passes each secret by name. `secrets: inherit` would hand the reviewer every secret the calling repository can see, including unrelated deploy or release keys, so a compromise of the reviewer source would expose all of them.

## Pin a release tag

A caller runs whatever the reviewer ref it names contains, with its secrets. Pin `uses:` and `reviewer_ref` to a release tag (or a commit SHA), not a branch, and keep them equal: the reusable workflow can't see its own ref, so `reviewer_ref` tells it which source to load. See [versioning.md](versioning.md).

## Accepted risk: approvals survive pushes

The bot's approval stays through later pushes, like a human approval in a repository that doesn't dismiss stale approvals. An approval can therefore stand on code the bot never saw. The approval is recorded on the commit it reviewed, and the summary names it. Callers that need otherwise should require approval of the most recent push in their branch protection or ruleset, or dismiss stale approvals on push. A caller that auto-merges approved dependency PRs should merge only the reviewed commit (`gh pr merge --auto --match-head-commit <sha>`).

## Other limits

- Generated paths are only sampled. Hand-written code placed under a `generatedPaths` entry is seen only if the sample or the listing gives it away. `generatedPaths` comes from the base branch.
- The reviewer can be wrong. It is one reviewer, not a replacement for code owners on high-risk changes, which it never approves.
