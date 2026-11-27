# The check workflow

`check.yml` runs the [modules](modules.md), for example a repository's [Rerail](rerail.md) rules, on every pull
request and posts each module's result as a GitHub check. No model runs, and nobody has to ask. Require the check in
a ruleset and it gates merges.

It is separate from `review.yml`. A review runs when someone asks for one; a required check has to report on every
pull request and every push, so it has its own workflow and its own caller file. A repository can use either or both:
the review posts module findings as comments, the check posts them as a check, and each run does its own scan.

## Turning it on

1. **Give the app the Checks permission.** In the GitHub App's settings, set Repository permissions → **Checks** to
   read and write, then accept the new permission on each installation. The check is posted as the app, so a ruleset
   can require it from the app and nothing else can stand in for it.
2. **Add the caller.** Copy [templates/check-caller.yml](../templates/check-caller.yml) to
   `.github/workflows/reviewer-check.yml`. Pin `uses:` and `reviewer_ref` to a release tag
   ([versioning.md](versioning.md)), name the modules, and choose the rule.
3. **Dependabot.** A run that Dependabot's push starts gets only Dependabot secrets. Store
   `REVIEWER_APP_PRIVATE_KEY` as a Dependabot secret too, or Dependabot's pull requests get no check.
4. **Require it.** Once a pull request shows the check, add it to the branch's ruleset as a required status check,
   with your app as its source. The check's name is the module's id and the base branch: for pull requests into
   `main`, `rerail (main)`.

The base branch is in the name because the result depends on it: the rules, the caller's `rule` and the merge base
all come from the base, while a check belongs to a commit, and one commit can be the head of pull requests into
several branches. A ruleset for `main` that requires `rerail (main)` is satisfied only by a scan against `main`.

## The rules

`rule` says when a check passes. One rule applies to every module the caller names.

| `rule` | The check passes when |
| --- | --- |
| `no-new` (default) | the change adds no error or warning |
| `not-more` | the files the change touches have no more errors and warnings than they had on the merge base |
| `zero` | the files the change touches have no error or warning |

- **What counts:** findings at the `error` and `warning` levels. For Rerail these are violations of rules in Block and
  Steer. A `note` (a rule in Log) is shown and never fails a check.
- **Which files:** the files the pull request changes, compared with the merge base. A finding in a file the pull
  request doesn't touch is not looked at, under any rule.
- **New or already there:** a finding is new when the merge base has none with the same fingerprint
  ([modules.md](modules.md#the-contract)). A finding that only moved lines is not new. A renamed file's findings are:
  the path is part of the fingerprint.
- **`not-more` counts, it doesn't match.** A change may add one finding if it removes another in the files it
  touches, including files it deletes. It needs the module to count the merge base (`baseline` in its result); the
  Rerail module does. With a module that doesn't, the check fails and says so.
- **A scan that fails, fails the check.** If the module doesn't complete, the check's conclusion is failure whatever
  the rule, and its summary carries the module's error.

## What the check shows

- **Title:** the result in one line, for example `New: 2 errors, 1 warning`.
- **Summary:** the module and its version, the rule, the counts by level (new, already there, and on the merge base),
  and the checks that found something.
- **Annotations:** the findings the rule is about, on their lines in the Files changed tab: the new ones, and under
  `zero` every error and warning in the files changed. At most 500 are marked; the summary counts the rest.

The workflow's own jobs succeed whatever the check concludes. A red job means the workflow itself broke, and then no
check is posted for that commit.

## When it runs

On every `pull_request_target` event the caller listens for: the template lists `opened`, `synchronize`, `reopened`,
`ready_for_review` and `edited`. Drafts, fork pull requests and bots' pull requests are all checked. A newer event
for the same pull request cancels a run still in progress. The check is posted on the commit that was scanned.

`edited` is there for a pull request that is moved to another base branch: the new base needs its own check. It
also fires when the title or description changes, which runs a scan that changes nothing. Without it, a moved pull
request has no check for its new base until the next push.

Any other event fails the run with a message: on `pull_request`, GitHub would run the pull request's own copy of the
caller, which could choose its own rule.

## Inputs and secrets

| Input | Required | Default | What it does |
| --- | --- | --- | --- |
| `app_client_id` | yes | | The GitHub App's client ID. |
| `reviewer_ref` | no | `main` | Ref of `neralabs/reviewer` to load the poster and the modules from. Keep it equal to the `@ref` in `uses:`. |
| `modules` | yes | | Module ids, space-separated. Each gets its own check, named `<id> (<base branch>)`. |
| `rule` | no | `no-new` | `no-new`, `not-more` or `zero` (above). |
| `rerail_package`, `rerail_packs`, `rerail_repo_packs` | no | `""` | The Rerail module's inputs, as in [rerail.md](rerail.md). |

| Secret | Required | What it is |
| --- | --- | --- |
| `REVIEWER_APP_PRIVATE_KEY` | yes | The app's private key. |
| `RERAIL_PACKAGE_URL` | no | Where to install Rerail from, when it must not appear in a public file. |
| `RESULTS_SINK_URL`, `RESULTS_SINK_TOKEN` | no | Only for `rerail_package: remote:<version>`, to download Rerail. The check workflow sends nothing to the sink. |

## How it works

| Job | Credentials | What it does |
| --- | --- | --- |
| scan | `GITHUB_TOKEN` (`contents: read`); each module's own inputs | Checks out the reviewer source and hands it on as an artifact, then checks out the pull request's head as data and runs the modules in diff mode, as the review's `modules` job does. |
| check | an app token with `checks: write` and nothing else | Reads the modules' results, re-checks them against the module contract, decides each by the rule, and creates one check run per module on the scanned commit. |

The job that reads the pull request holds no app key. The job that holds it reads only the modules' checked results,
and runs the reviewer source as it was before the pull request was checked out
([security-model.md](security-model.md#the-check-workflow)).

## Limits

- **The rules pass has no say.** In a review, the rules pass may call a module finding a false positive. The check
  doesn't read it: the same commit always gets the same check. Change the rule, or the code, to clear a finding.
- **A base branch that moves on** doesn't run the check again. A rule added to `main` after a pull request was
  checked applies to it from its next push, as with any CI check, unless the ruleset requires branches to be up to
  date.
- **5,000 findings.** A module result with more findings than that, notes and already-existing ones included,
  counts as failed as a whole ([modules.md](modules.md#the-contract)), and so fails the check under every rule.
- **Merge queues** are not supported: the workflow handles `pull_request_target` only.
- **Rules come from the base branch.** A pull request that adds or edits a Rerail rule is checked by the rules its
  base has, and its own rule runs unapproved, in Log ([rerail.md](rerail.md#what-it-does)).
