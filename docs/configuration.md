# Configuration

A target repository configures the reviewer in three places: the caller workflow (inputs and secrets), `REVIEW.md` (the review bar and a settings block), and `CODEOWNERS` (who gets escalations). Start from [templates/caller.yml](../templates/caller.yml) and [templates/REVIEW.md](../templates/REVIEW.md).

## Workflow inputs

Passed under `with:` in the caller.

| Input | Required | Default | Meaning |
|---|---|---|---|
| `app_client_id` | yes | | Client ID of the GitHub App the reviewer posts as. Usually `${{ vars.REVIEWER_APP_CLIENT_ID }}`. |
| `provider` | yes | | Where Claude runs: `anthropic` (the Claude API) or `bedrock` (Amazon Bedrock). |
| `model` | yes | | A pinned model id, not an alias, so reviews don't change model under you. Claude API: for example `claude-opus-5-5`. Bedrock: a model id or inference profile, for example `us.anthropic.claude-opus-5-5`, or an inference profile ARN. Subagents use the same model. |
| `aws_region` | with `bedrock` | `""` | Bedrock region, for example `us-east-1`. |
| `reviewer_ref` | no | `main` | Ref of the reviewer source to load the skill, prompts and poster from. Set it to the same ref as the `@ref` in `uses:`; a reusable workflow can't see its own ref. Pin a release tag ([versioning.md](versioning.md)). |
| `team_slug` | no | `reviewer` | Slug of the team whose review request starts a review. Commands addressed to `@<owner>/<team_slug>` also count. |
| `handle` | no | `@neralabs-reviewer` | Comment handle for commands: `@` plus your app's slug. |
| `bot_login` | no | `neralabs-reviewer[bot]` | Your app's bot login: its slug plus `[bot]`. The gate uses it to recognise the bot's own comments and threads. |
| `allow_approve` | no | `false` | Let the poster approve PRs that pass the low-risk rules (and dependency PRs that pass their guards). Off, the bot only comments or requests changes. |
| `max_budget_usd` | no | `"15"` | Spend cap for one review run, passed to Claude Code as `--max-budget-usd`. |
| `large_pr_lines` | no | `50000` | Changed lines, excluding generated files, above which a review is summary-only unless someone asks for `review full`. `largePrLines` in `REVIEW.md` overrides it. |
| `modules` | no | `""` | Deterministic checks to run beside the review, space-separated module ids ([modules.md](modules.md)), e.g. `rerail`. With modules, a `schedule` or `workflow_dispatch` trigger in the caller runs them over the whole branch. |
| `rules_pass_budget_usd` | no | `"3"` | Spend cap for the rules pass, the second model step over the modules' new findings. |
| `rerail_package` | with `modules: rerail` | `""` | What to install Rerail from: an npm spec, a tarball URL, or `remote:<version>` from the results sink ([rerail.md](rerail.md)). |
| `rerail_packs` | no | `""` | Rerail's own rule packs, space-separated ids. |
| `rerail_repo_packs` | no | `""` | Rule packs in the repository, space-separated paths from its root. Taken from the base branch only and approved there. |
| `send_results` | no | `false` | Send the modules' results to the results sink ([modules.md](modules.md#the-results-sink), [privacy.md](privacy.md)). |
| `claude_code_version` | no | pinned in `review.yml` | Version of `@anthropic-ai/claude-code` to install. Change it only together with a reviewer release that was tested with it. |

The review job times out after 30 minutes.

### Another organization

The defaults for `team_slug`, `handle` and `bot_login` name the `neralabs-reviewer` app and the `neralabs/reviewer` team. For your own app `<app>` and team `<org>/<team>`:

```yaml
    with:
      app_client_id: ${{ vars.REVIEWER_APP_CLIENT_ID }}
      team_slug: <team>
      handle: "@<app>"
      bot_login: <app>[bot]
```

## Secrets

Passed by name under `secrets:` in the caller. Don't use `secrets: inherit`: it hands the reviewer every secret the repository can see ([security-model.md](security-model.md#explicit-secrets-not-inherit)).

| Secret | Required | Meaning |
|---|---|---|
| `REVIEWER_APP_PRIVATE_KEY` | yes | Private key of the GitHub App. |
| `REVIEWER_ANTHROPIC_API_KEY` | with `anthropic` | Claude API key. Reaches the Claude Code step as `ANTHROPIC_API_KEY`. |
| `REVIEWER_BEDROCK_API_KEY` | with `bedrock` | Amazon Bedrock API key. Reaches the Claude Code step as `AWS_BEARER_TOKEN_BEDROCK`. |
| `RERAIL_PACKAGE_URL` | no | Rerail module: where to install Rerail from, when that URL must not appear in a public file. Overrides `rerail_package`. |
| `RESULTS_SINK_URL`, `RESULTS_SINK_TOKEN` | with `send_results`, or `rerail_package: remote:<version>` | The results sink and its token. They reach the `send` job, and for `remote:<version>` the Rerail module's install. |

Only the chosen provider's key reaches the step. The step fails with a clear error if the provider, key and region don't match.

### Amazon Bedrock

[infra/bedrock.yml](../infra/bedrock.yml) is an example CloudFormation template for a Bedrock key. It creates:

- an IAM user with no password or access keys, allowed only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the model or inference profile ARNs you give it (plus what a long-term Bedrock API key and Claude Code's model lookup need);
- a monthly cost budget that emails a list of addresses past an alert threshold;
- a budget action that, at the limit, attaches a deny-all-Bedrock policy to the user, so reviews fail until someone detaches it or the month ends.

Deploy it, then create a long-term Bedrock API key for the user and store it as `REVIEWER_BEDROCK_API_KEY`. The template's header lists the commands. Deploy it in an AWS account used only for the reviewer if you can, since the budget counts the whole account's spend.

## REVIEW.md

`REVIEW.md` at the repository root is the repository's review bar. The reviewer reads it **from the base branch** on every review, on top of the shared bar in `skill/review/team-context.md`. Write it for a reviewer new to the repository: what the repository is, what blocks a merge, known gaps that shouldn't be reported again, and high-risk areas. See [templates/REVIEW.md](../templates/REVIEW.md).

### Settings block

A fenced block opened with ` ```json reviewer ` holds the machine-readable settings:

````markdown
```json reviewer
{
  "highRiskPaths": ["native/src/engine/", "migrations/", ".github/workflows/"],
  "generatedPaths": ["**/generated/", "*.snap"],
  "largePrLines": 50000
}
```
````

| Key | Type | Default | Meaning |
|---|---|---|---|
| `highRiskPaths` | string list, CODEOWNERS path syntax | `.github/`, `REVIEW.md`, `CODEOWNERS` | A PR touching one of these is never approved. Entries add to the defaults. Issue and PR templates under `.github/` are outside the built-in `.github/` entry; list them (for example `.github/ISSUE_TEMPLATE/`) to make them high-risk. |
| `generatedPaths` | string list, CODEOWNERS path syntax | common lock files (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Gemfile.lock`, `composer.lock`, `go.sum`), `*.min.js`, `*.min.css` | Files nobody writes by hand: generated code, snapshots, goldens, vendored data. The model sees only a listing and a small sample of them, and they don't count toward `largePrLines`. Entries add to the defaults. |
| `largePrLines` | positive integer | the caller's `large_pr_lines` | Changed-line threshold for a summary-only review. Overrides the caller input, up or down. |
| `dependencyUpdates` | object | none | Dependency bot PRs, reviewed when CI finishes and approvable past the high-risk and bot-author rules. See [Dependency PRs](#dependency-prs). |

Unknown keys are an error. If the block doesn't parse, approval is off and the review says why. Without a block, the defaults apply.

Changes to `REVIEW.md` change what blocks a merge, so review them like code. The file is always a high-risk path.

### Dependency PRs

````markdown
```json reviewer
{
  "dependencyUpdates": {
    "authors": ["dependabot[bot]"],
    "pushers": ["neralabs-ci[bot]"],
    "pinFiles": ["scripts/host/install-omp-host.mjs"],
    "knownGaps": {
      "pack-data": "Jobs that need an OIDC token (test data, conformance) skip on Dependabot PRs."
    }
  }
}
```
````

| Key | Type | Default | Meaning |
|---|---|---|---|
| `authors` | bot login list, required | | Bots whose PRs are dependency PRs. Only logins ending in `[bot]`. |
| `pushers` | bot login list | `[]` | Other bots allowed to add commits to those PRs, such as a workflow that brings pinned files along. |
| `pinFiles` | string list, CODEOWNERS path syntax | `[]` | Files those PRs may change freely besides manifests and lock files. |
| `knownGaps` | object, id → description | `{}` | CI that doesn't run for these PRs. A `needsRun` follow-up or nit that only restates one of these (the model sets `knownGap` to its id) doesn't withhold approval. Ids are lowercase letters, digits and dashes. |

The guards that decide approval are in [architecture.md](architecture.md#verdict-and-approval-policy), and why they are safe is in [security-model.md](security-model.md#dependency-prs).

To review these PRs without anyone asking, add a `workflow_run` trigger for your CI workflow to the caller:

```yaml
on:
  workflow_run:
    workflows: [CI] # the `name:` of the workflow whose success should start the review
    types: [completed]
```

The gate reviews a PR from that trigger only when: the run was a successful `pull_request` run for one same-repository PR; the PR is open, not a draft, and its author is in `authors`; the run's commit is still the PR's head; the bot hasn't reviewed that head; and no other check at the head is pending or failing. If another workflow at the head finishes after CI, no review starts. Request the team to review then.

Dependabot-started runs get only Dependabot secrets. Add the reviewer's secrets to the repository's **Dependabot** secrets too, under the names the caller reads: the app key, and the model key for your provider. Variables, such as `REVIEWER_APP_CLIENT_ID`, aren't restricted.

## CODEOWNERS

The poster reads `CODEOWNERS` from `.github/`, the repository root or `docs/`, on the base branch. When it escalates, it resolves the owners of the relevant paths (the last matching pattern wins, as on GitHub), requests them as reviewers and mentions them in the summary. It never requests the PR author or someone who already reviewed the current head. Without a `CODEOWNERS`, it mentions the repository admins and reports the missing file as a follow-up.

## Team

The team named by `team_slug` is how people request a review from the reviewer. Keep it without members (GitHub adds the creator; remove them) and with notifications off, and give it read access to each target repository so it can be requested. The app needs the organization **Members** read permission: without it, GitHub silently ignores the app's removal of the team request, so the request stays and can't be made again for the next review.
