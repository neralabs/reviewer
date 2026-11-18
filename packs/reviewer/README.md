# Rerail rule pack: Reviewer repository

Rules for working in neralabs/reviewer. They hold in place the boundaries the reviewer's design depends on (who may
write to GitHub, what the model may do, which code is pure) and the layout its tooling assumes. The first half of this
file is the architecture they come from, as the code has it today; the second half is the rules.

All 9 rules are code rules in Steer mode, and none matches anything on `main` today. The pack is private
(`"private": true`): it is never published. `.rerail/packs.json` names it by path, so a scan of this repository runs
it. To use it in your sessions, add it once from a checkout, then approve it after reading it:

```sh
rerail packs add ./packs/reviewer
rerail rules approve @neralabs/rerail-pack-reviewer
```

An edit to a rule needs approval again; until then it runs in Log.

## The architecture as it is

### Parts

| Part | What it owns |
| --- | --- |
| `.github/workflows/review.yml` | The product: a reusable workflow with eight jobs (`gate`, `modules`, `send`, `review`, `rules-pass`, `post`, `respond`, `report-failure`). Each job checks out the reviewer source, then runs one command of the poster or the model launcher. Jobs pass data only through artifacts. |
| `poster/src/` | All of the logic, in one TypeScript CLI (`cli.ts`) that Node 24 runs directly, with no build step. One runtime dependency, `ajv`. |
| `scripts/run-claude.sh` | The model launcher: Claude Code with its lockdown flags, for the review and for the rules pass. |
| `skill/review/`, `prompts/`, `agents/` | What the model reads: the review procedure (system prompt), the prompt templates the poster fills in, and the vendored ECC subagents (MIT, `REUSE.toml`). |
| `schema/` | The JSON Schemas: `findings` and `rules-pass` (model output), and `module-results` (the module contract). |
| `modules/<id>/` | Deterministic checks beside the review. Today one: `modules/rerail/` (`run.sh`, `install.sh`, `run.ts`, `module.json`, `test/`). |
| `templates/` | What a calling repository copies: `caller.yml` and `REVIEW.md`. |
| `infra/bedrock.yml` | An example CloudFormation template for a Bedrock key scoped to one model. Nothing runs it. |
| `scripts/check/` | The repository's own checks: licences and internal references. |
| `docs/` | Architecture, security model, modules, Rerail, configuration, privacy, versioning. |

### Dependency direction

Inside `poster/src/` the import graph has no cycles and three layers:

- **Pure decision modules**: `commands`, `patterns`, `text`, `diff`, `dependency`, `review-config`, `policy`,
  `render`, and `gate`, which takes its I/O as `GateDeps`. They import each other and, for types only, `ci.ts`.
- **I/O adapters**: `github` (the GitHub client), `settings` (environment and step outputs), `bot-history`, `ci`,
  `modules` (the module runner), `sink` (the results sink), `agents`, `findings` (loads and validates the model's
  output), `rules-pass`.
- **Commands**: `prepare`, `post`, `respond`, `module-commands`, and `cli`, which dispatches to them. `post.ts` imports
  two helpers from `respond.ts`; nothing imports `post.ts` statically, because it pulls in `ajv`, which only the post
  job installs (`cli.ts` loads it with `await import`).

Across parts: the workflow calls `poster/src/cli.ts` and `scripts/run-claude.sh`; `poster/src/modules.ts` runs
`modules/<id>/run.sh` as a separate process and reads back `results.json`. No module imports the poster, and the
poster's source imports no module (only `poster/test/` reaches into `modules/rerail/`). Modules import only `node:`
built-ins: `modules/package.json` declares no dependencies.

### Boundaries

| Boundary | Where | Holds today |
| --- | --- | --- |
| Only the `GitHub` class talks to the GitHub API: no octokit, no `gh`, no `curl` to the API. | `poster/src/github.ts`, on `fetch` | Yes. The only other network calls are the results sink (`poster/src/sink.ts`, `modules/rerail/install.sh`) and package installs. |
| Only `post` and `respond` write to GitHub (REST writes, GraphQL mutations), with the app token `APP_TOKEN`; every other command reads with the read-only `GITHUB_TOKEN`. | `poster/src/post.ts`, `poster/src/respond.ts`; `APP_TOKEN` is set in `review.yml` for the `post`, `respond` and `report-failure` jobs only | Yes. |
| The job that reads untrusted pull request content holds no credential that can write. The model process holds no GitHub token, only the chosen provider's key. | `review.yml` (`review`, `rules-pass`); `scripts/run-claude.sh` unsets the other provider's key | Yes. |
| The model reads pull request content with read-only tools: no shell, no edits, no web, no MCP, nothing allowed without pre-approval. Subagents get `Read`, `Grep`, `Glob`. | `scripts/run-claude.sh` (`--restricted`, `--permission-mode dontAsk`, `--allowedTools`), the `ALLOWED_TOOLS` override in `review.yml`, `SUBAGENT_TOOLS` in `poster/src/agents.ts` | Yes. |
| Pull request content is data: checked out without credentials, scrubbed of agent configuration and symlinks, never run. Repository configuration (`REVIEW.md`, `CODEOWNERS`, module rules) comes from the base branch. | `poster/src/prepare.ts` (`scrub`, `git show origin/<base>:…`), `modules/rerail/run.ts` (approves only from `MODULE_BASE_CHECKOUT`) | Yes. |
| Model output is validated before anything is posted, and the verdict is computed, never taken from the model. | `poster/src/findings.ts` (ajv, strict), `poster/src/text.ts` (`sanitizeModelText`), `poster/src/policy.ts` | Yes for findings. The rules pass's output and module results are checked by hand (`rules-pass.ts`, `modules.ts`); only tests tie those checks to their schemas. |
| The decision modules are pure: no file, process, network or environment access. | the pure modules above | Yes. |
| Programs are started only by `prepare.ts` (git, with `--no-ext-diff`, `--no-textconv` and LFS smudging off) and `modules.ts` (git, and each module's `run.sh`). | `poster/src/prepare.ts`, `poster/src/modules.ts`; `modules/rerail/run.ts` starts `rerail` and git | Yes. |
| The core knows no module by name. A module is `modules/<id>/run.sh`, found by its id (`^[a-z][a-z0-9-]{0,39}$`), run with the `MODULE_*` variables, and answers with `results.json` (`reviewer.module-results/1`). | `poster/src/modules.ts`, `docs/modules.md` | Yes. `module.json` is documentation: no code reads it. |
| Callers run the reviewer on `pull_request_target` (never `pull_request`) and pass each secret by name (never `secrets: inherit`). | `templates/caller.yml`, `docs/security-model.md` | Yes. |

### Versioning

The whole reviewer (workflow, poster, scripts, prompts, schemas) is one release: a semver tag, which a caller pins in
both `uses:` and `reviewer_ref` (`docs/versioning.md`). Nothing is versioned per file. Prompts (`prompts/*.md`,
`skill/review/SKILL.md`, `agents/*.md`) carry no version; a prompt change is a patch release. Schemas are found by
path (`schema/<name>.schema.json`), and their `$id`s carry no version. The versions that travel in data are
`reviewer.module-results/1` (module results), `{"v":1,…}` (the hidden review-state marker), `rerail.scan/1` (what the
Rerail module reads) and `protocol: 1` (the results sink's batch header). A change to the findings schema, a caller
input or secret, the `REVIEW.md` settings or the command syntax is breaking.

### Conventions

- Licensing lives in `REUSE.toml`, not in file headers; `reuse lint` and `scripts/check/check-licenses.mjs` check it,
  and `scripts/check/check-internal-refs.mjs` keeps ticket ids, account ids and staff addresses out of tracked files.
- The poster is ESM TypeScript run by Node's type stripping: `.ts` extensions in imports, `node:` built-ins, `import
  type` for types, no enums or namespaces (`poster/tsconfig.json`). Every source file opens with a comment on its role.
- Tests use `node:test` and `node:assert/strict`. `npm test` in `poster/` runs `poster/test/*.test.ts` and
  `modules/*/test/*.test.ts`, and nothing else.
- Shell scripts start with `set -euo pipefail`; CI runs ShellCheck and actionlint on them and the workflows.
- Workflows set `permissions` per job (`review.yml` starts from `permissions: {}`), check out with
  `persist-credentials: false`, and give every job a `timeout-minutes`.

## Rules

| Group | Rule | What it flags | Mode |
| --- | --- | --- | --- |
| GitHub and credentials | `reviewer-github-writes-in-post` | A REST write, a GraphQL mutation or `APP_TOKEN` in `poster/src/` outside `post.ts` and `respond.ts` | Steer |
| GitHub and credentials | `reviewer-github-through-client` | `fetch()` outside `github.ts` and `sink.ts`, the `gh` CLI, or the API's address in the poster, modules, scripts and workflows | Steer |
| Untrusted input | `reviewer-model-read-only` | A shell, edit, web or MCP tool in the model's allowed tools or `SUBAGENT_TOOLS`, or a permission bypass | Steer |
| Untrusted input | `reviewer-caller-pull-request-target` | A `pull_request` trigger or `secrets: inherit` in the caller template and the docs | Steer |
| Layering | `reviewer-pure-core` | File, process, network or environment access in the pure decision modules | Steer |
| Layering | `reviewer-subprocess-owners` | `child_process` in `poster/src/` outside `prepare.ts` and `modules.ts` | Steer |
| Layering | `reviewer-module-boundary` | The poster importing a module, a module importing the poster, or a module importing an npm package | Steer |
| Layering | `reviewer-poster-dependencies` | An npm package other than `ajv` in `poster/src/`, `ajv` outside `findings.ts`, or a static import of `post.ts` or `findings.ts` | Steer |
| Repository layout | `reviewer-test-placement` | A test file under `poster/` or `modules/` that `npm test` doesn't run | Steer |

## Rule details

Each rule is in Steer: it matches nothing on `main`, so every match it reports is new. A reviewer caller that runs the
pack through its Rerail module (`rerail_repo_packs: packs/reviewer`) maps Steer to the `warning` level, and a new
warning there is a blocker.

### `reviewer-github-writes-in-post`

The review job reads untrusted pull request content and holds only the read-only `GITHUB_TOKEN`; the write
credential is minted for the post, respond and report-failure jobs alone (`docs/architecture.md`, "Jobs"). In the
poster that split is two files: `post.ts` and `respond.ts` create the write client from `APP_TOKEN` and make every
write. The rule flags, anywhere else in `poster/src/`, a `request` or `send` call whose method is `POST`, `PUT`,
`PATCH` or `DELETE`, a GraphQL `mutation` string, and the name `APP_TOKEN`. `github.ts` is the transport and is out of
scope: its GraphQL queries go out as `POST`.

Gaps: a write made with the method in a variable passes; the GraphQL check reads string literals that start with
`mutation`.

### `reviewer-github-through-client`

`poster/src/github.ts` is the one GitHub client: it sets the API base, the token header and pagination. The rule
flags a direct `fetch()` call in the poster or a module outside `github.ts` (and `sink.ts`, which talks to the results
sink through an injectable `fetch`), the `gh` CLI started from TypeScript, and `gh api`/`gh pr`/… commands or
`api.github.com` in scripts, module scripts and workflow steps. Actions that talk to GitHub themselves
(`actions/checkout`, `actions/create-github-app-token`) pass. The pure modules are left to `reviewer-pure-core`, and
npm clients to `reviewer-poster-dependencies` and `reviewer-module-boundary`, so a line is reported once.

### `reviewer-model-read-only`

The model reads pull request content, so the reviewer gives it no way to act on it: `--restricted`, no MCP,
`--permission-mode dontAsk`, `Read,Grep,Glob,Agent` (the rules pass: `Read`), and subagents with `Read`, `Grep` and
`Glob` (`docs/architecture.md`, "Claude Code invocation"). The rule flags `Bash`, `Edit`, `MultiEdit`, `Write`,
`NotebookEdit`, `WebFetch`, `WebSearch` or an `mcp__` tool on a line that sets `--allowedTools`, `allowed_tools` or
`ALLOWED_TOOLS` in `scripts/` or the workflows, the same tools in `SUBAGENT_TOOLS` in `poster/src/agents.ts`, and
`--dangerously-skip-permissions` or a permission mode other than `dontAsk`. Comment lines pass, and so does
`--disallowedTools`.

Gaps: removing a flag (`--restricted`, `--strict-mcp-config`, an entry of `--disallowedTools`) can't be expressed as
a match, so it passes; tools named through a variable set elsewhere pass.

### `reviewer-caller-pull-request-target`

`pull_request_target` runs the caller from the base branch; `pull_request` runs the pull request's own copy, which
could turn approvals on or point at another reviewer (`docs/security-model.md`, "pull_request_target only"). And
`secrets: inherit` would hand the reviewer every secret of the calling repository ("Explicit secrets, not inherit").
The rule flags a `pull_request:` key or an `on:` list naming `pull_request`, and `secrets: inherit`, in `templates/`,
`docs/` and the root `README.md`, so what callers copy can't teach either. Prose that names them in backticks passes,
and this repository's own `ci.yml`, which is not a caller, is out of scope.

### `reviewer-pure-core`

`commands`, `patterns`, `text`, `diff`, `dependency`, `review-config`, `policy`, `render` and `gate` decide what the
reviewer does (the gate's decision, the verdict, the rendering) and are tested as plain functions; `gate.ts` takes its
I/O as `GateDeps`. The rule flags in those files an import of a Node I/O built-in (`fs`, `child_process`, `net`,
`http`, `https`, `os`, `worker_threads` and the like) or of an I/O module of the poster (`github`, `settings`,
`bot-history`, `ci`, `modules`, `sink`, `agents`, `findings`, `rules-pass` or a command), any use of `process`, and a
`fetch()` call. Type-only imports pass.

Gaps: the list of pure files is in the rule's scope; a new pure module is covered once it is added there.

### `reviewer-subprocess-owners`

Running git on pull request content is where a checkout could run code: `prepare.ts` runs it with external diff,
textconv and LFS smudging off, and `modules.ts` runs module scripts with a timeout and the `MODULE_*` contract. The
rule flags `child_process` imported anywhere else in `poster/src/`; type-only imports pass, and the pure modules are
left to `reviewer-pure-core`.

### `reviewer-module-boundary`

"The core of the reviewer knows nothing about any one module" (`docs/modules.md`): the poster runs `run.sh` and reads
`results.json`, nothing more, and a module stays a self-contained folder that runs on Node with no install. The rule
flags an import of `modules/…` from `poster/src/`, an import of `poster/…` from `modules/`, and an npm package
imported by a module (anything but a relative path or a `node:` built-in). `poster/test/` may import module code.

### `reviewer-poster-dependencies`

The poster runs with the caller's app token, so its dependency set stays small (`CONTRIBUTING.md`, "Dependencies"),
and every job but post runs it with nothing installed: `cli.ts` imports `post.ts` dynamically because `post.ts`
pulls in `ajv`. The rule flags, in `poster/src/`, an import of any npm package but `ajv` (a `node:` built-in or a
relative path passes), `ajv` imported outside `findings.ts`, and a static import of `post.ts` or `findings.ts` from
any file but `post.ts`. Type-only imports pass.

Gaps: it can't follow imports transitively, so a file that `post.ts` alone imports and that imports `findings.ts`
statically is flagged too; import it from `post.ts` or with `await import`.

### `reviewer-test-placement`

`npm test` runs `node --test test/*.test.ts ../modules/*/test/*.test.ts` from `poster/`, so a test anywhere else
never runs and its failures never show. The rule flags any `*.test.*` or `*.spec.*` file under `poster/` or `modules/`
except `poster/test/<name>.test.ts` and `modules/<id>/test/<name>.test.ts`.

## Testing

`cases/<rule id>.cases.json` holds the cases each rule was drafted with: files it must catch and files it must let
pass, near misses included. Run them, and list where each rule matches in this checkout:

```sh
packs/reviewer/test.sh            # all rules
packs/reviewer/test.sh <rule id>  # one rule
```

It needs `rerail` on `PATH` (or `RERAIL=<launcher>`) and `jq`. The `Rerail pack` job in `.github/workflows/ci.yml`
runs it on every pull request and push to `main`, then adds the pack in a fresh Rerail home, approves it and scans the
checkout, as a scan of this repository does. A new rule needs a `rules/<id>.json`, a `cases/<id>.cases.json` with at
least two caught and two passed cases, an entry in `pack.json` and a section here. The repository pass of
`rerail rules test` skips hidden folders, so it reports no matches under `.github/`; the cases are the proof there,
and the scan reads `.github/` like any folder.
