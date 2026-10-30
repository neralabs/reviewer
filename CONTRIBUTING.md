# Contributing to Reviewer

Thank you for helping. This guide covers how contribution works, how work starts, how to set up a checkout, what a
pull request needs, and the rules that keep the project open source and its licensing clean.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report a security vulnerability privately, as
[SECURITY.md](SECURITY.md) describes, never in a public issue or pull request.

## How contribution works

Reviewer is open source with gated contribution. Anyone can propose a change, from their fork. Code reaches this
repository only through a pull request from a branch here, which contributors and the project's own automation open.
Nera Software employees are contributors by being on the team; anyone else becomes one by approval.

| | Anyone | Contributors |
| --- | --- | --- |
| Report a bug or a bad review, request a feature, ask a question | Yes, in an issue | Yes |
| Propose a change from a fork: a pull request, or a branch linked from an issue ([below](#proposing-a-change-from-your-fork)) | Yes, with no CI | Not needed |
| Push branches here and open pull requests from them, with CI | [Become a contributor](#becoming-a-contributor) | Yes |
| Claim a `good first issue` or `help wanted` issue | Become a contributor | Yes |

The automation is Dependabot, for dependency updates. Its pull requests are reviewed and merged like any other.

### Proposing a change from your fork

Anyone can write the change themselves:

1. Open an issue for it, or find the one that covers it.
2. Fork the repository and make the change on a branch in your fork, with tests, as
   [Before you open a pull request](#before-you-open-a-pull-request) describes.
3. Open a pull request from your fork against `main`, or link the branch in the issue.

No CI runs on a fork's pull request. GitHub holds every fork run until a maintainer approves it, and maintainers do not
approve them. Run the checks yourself and say in the pull request what you ran.

A maintainer reviews it there. If it goes in, the maintainer ports it onto a branch here in their own pull request,
credits you with a `Co-authored-by:` trailer on the commit, and closes your pull request with a link to the new one.
What you submit is licensed under Apache-2.0 ([Licence of contributions](#licence-of-contributions)).

## Contributors

Contributors push branches to this repository and open pull requests from them, so CI runs on their changes. Nera
Software employees are contributors by being on the team. Anyone else applies, and the maintainers approve them. Being
a contributor is not a path to maintainer: Nera Software appoints maintainers.

### Becoming a contributor

Ask in the issue you want to work on, or open one with the
[contributor form](https://github.com/neralabs/reviewer/issues/new?template=4-trusted-contributor.yml): say what you
want to change and how you would go about it. For anything in [Start with an issue](#start-with-an-issue), that is the
conversation a maintainer has with you anyway.

Maintainers look at:

- the issue itself: a reproduction, a failing case, or an approach that holds up;
- changes you proposed from your fork, and how they went;
- whether the change fits where Reviewer is going, at a size you can finish;
- how you have worked in the issues so far, under the [Code of Conduct](CODE_OF_CONDUCT.md).

A maintainer answers in the issue. If it's a yes, they add you to the list below and assign you the issue. If it's not
yet, they say why and what would change it.

Push access for contributors outside Nera Software comes once the repository is set up for it. Until then, an approved
contributor proposes from their fork like anyone else
([Proposing a change from your fork](#proposing-a-change-from-your-fork)).

### The list

Contributors from outside Nera Software are listed here. The list changes only through a maintainer's pull request
that links the issue where it was agreed, so every name on it has a public reason.

Contributors outside Nera Software: none yet.

### Leaving the list

- Ask, in any issue or at [opensource@nera.software](mailto:opensource@nera.software), and you are taken off.
- Twelve months without a pull request, issue or comment here takes you off. Ask again any time.
- Breaking the Code of Conduct can take you off, as its enforcement steps describe.

Leaving the list removes your push access.

## Start with an issue

Open an issue before you start on:

- a new feature, or a change to how the reviewer behaves;
- a change to a caller input or secret, the `REVIEW.md` settings, the findings schema or the command syntax
  (these are breaking for callers; see [docs/versioning.md](docs/versioning.md));
- a [security-sensitive change](#security-sensitive-changes);
- anything that spans several parts of the repository.

Agree on the approach with a maintainer in the issue before you write the code. A pull request for work nobody agreed
on may be closed, however good it is.

Contributors take these straight to a pull request, with no issue; from a fork, they are a proposal like any other:

- typo and documentation fixes;
- a bug fix with a test that fails without it.

### Claiming an issue

Issues labelled `good first issue` or `help wanted` are open to any contributor, and asking for one is a good way to
become one ([Becoming a contributor](#becoming-a-contributor)). Check that the issue is not assigned, then comment on it
to claim it; a maintainer assigns it to you. If there is no pull request or update from you within two weeks, the issue
is open to others again.

## Contribution flow

**From a branch here** (contributors):

1. Find an issue, or open one ([Start with an issue](#start-with-an-issue)).
2. Claim it or assign it to yourself, and agree on the approach with a maintainer when the issue needs one.
3. Create a branch from `main` in this repository.
4. Set up your checkout ([Development setup](#development-setup)), make the change, and add tests for the behavior it
   changes.
5. Run the checks in [Before you open a pull request](#before-you-open-a-pull-request).
6. Open a pull request against `main` that links the issue (`Fixes #123`) and says how you tested the change.
7. A code owner reviews it, and a second maintainer too for a
   [security-sensitive change](#security-sensitive-changes). Push fixes to the same branch. Once it is approved and CI
   passes, it is squash-merged.

**From a fork** (anyone): steps 1, 4 and 5 as above, on a branch in your fork, then open a pull request from it or link
the branch in the issue ([Proposing a change from your fork](#proposing-a-change-from-your-fork)).

## Getting help

Ask in the issue you are working on, or open an issue with your question.

### Response times

These are the times we aim for, counted in business days: a first response within 5, and a decision within 10. For a
bug or a bad review we also aim to have the fix merged to `main` within the 10 days; when it ships depends on the next
release ([docs/versioning.md](docs/versioning.md)).

| You sent | First response | Decision |
| --- | --- | --- |
| A vulnerability report ([SECURITY.md](SECURITY.md)) | 2 business days | As [SECURITY.md](SECURITY.md) describes |
| A conduct report ([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md#reporting)) | 3 business days | As the [Code of Conduct](CODE_OF_CONDUCT.md#what-happens-next) describes |
| A bug report or bad review | 5 business days: triaged, labelled, or asked for a reproduction | 10 business days: what we will do, with a reason; the fix is the aim |
| A feature request | 5 business days | 10 business days: accepted, declined, or "not now" with a reason |
| A change from your fork ([Proposing a change from your fork](#proposing-a-change-from-your-fork)) | 5 business days | 10 business days: ported, or declined with a reason |
| A request to become a contributor | 5 business days | 10 business days: yes, or not yet with what would change it |
| A question | 5 business days | 10 business days: answered |

If an issue or pull request gets no reply within its window, comment on it to bring it back up.

## Development setup

The repository holds the reusable workflow, the scripts and prompts it runs, and the poster:

| Part | Where |
| --- | --- |
| Reusable workflow | [.github/workflows/review.yml](.github/workflows/review.yml) |
| Model session | [scripts/run-claude.sh](scripts/run-claude.sh), [skill/](skill/), [prompts/](prompts/), [agents/](agents/) |
| Findings schema | [schema/](schema/) |
| Poster: prepares the context, gates, renders and posts the review (TypeScript, Node) | [poster/](poster/) |
| Caller workflow template | [templates/](templates/) |

How they fit together is in [docs/architecture.md](docs/architecture.md).

Prerequisites: Node.js (the version `review.yml` sets in `NODE_VERSION`), npm,
[actionlint](https://github.com/rhysd/actionlint), [ShellCheck](https://www.shellcheck.net) and
[uv](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/neralabs/reviewer.git
cd reviewer
(cd poster && npm ci --ignore-scripts && npx tsc --noEmit && npm test)
actionlint
shellcheck scripts/*.sh
uvx --from 'reuse[charset-normalizer]==6.2.0' reuse lint
node scripts/check/check-licenses.mjs
node scripts/check/check-internal-refs.mjs
```

To try a change end to end, point a test repository's caller workflow at your branch, in both `uses:` and
`reviewer_ref` ([docs/configuration.md](docs/configuration.md)).

## Security-sensitive changes

A review from the reviewer's GitHub App can approve a pull request, and that approval can count as a required review
in the caller's branch protection. So these changes get a second maintainer's review on top of the code owner's:

- the verdict policy: when the poster approves, comments, requests changes or escalates to a person;
- the poster ([poster/](poster/)), above all what it posts and how it sanitizes model output;
- the findings schema ([schema/](schema/));
- the workflow ([.github/workflows/review.yml](.github/workflows/review.yml)): its triggers, permissions, secrets and
  what runs with them, and the model's lockdown in [scripts/run-claude.sh](scripts/run-claude.sh);
- how `REVIEW.md` is parsed, since the pull request under review can change it.

Say in the pull request which of these it touches. [docs/security-model.md](docs/security-model.md) explains what each
layer protects.

## Before you open a pull request

Open a pull request against `main` that links its issue, if it has one. Changes are squash-merged after review.

- In `poster/`, `npx tsc --noEmit` and `npm test` pass.
- `actionlint` and `shellcheck scripts/*.sh` pass.
- `reuse lint`, `node scripts/check/check-licenses.mjs` and `node scripts/check/check-internal-refs.mjs` pass.
- Tests cover the behavior you changed, and docs that describe it are updated.
- A change callers see is described in the pull request, for the release notes; a breaking one says how callers
  upgrade ([docs/versioning.md](docs/versioning.md)).

## Reporting a bug

Open an issue with the [bug form](https://github.com/neralabs/reviewer/issues/new?template=1-bug.yml). For a review
that got something wrong, use the
[bad review form](https://github.com/neralabs/reviewer/issues/new?template=2-bad-review.yml). Leave out secrets and
code you cannot share.

## Large changes

For a change that spans components, changes a caller input, the settings format, the findings schema or the commands,
or changes how the reviewer decides a verdict:

- write a short design in the issue first: the problem, the approach, the alternatives, and what it changes for
  existing callers (compatibility and upgrade);
- once it is agreed, split it into pull requests that each build and pass on their own;
- keep refactoring and behavior changes in separate pull requests.

## Licence of contributions

Reviewer is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). By submitting a contribution you agree that it
is licensed under the same terms, as described in section 5 of the licence. There is no contributor licence agreement
and no sign-off to add.

## Third-party material

Do not paste code, prompts or data from another project without recording it. Only permissively licensed material is
accepted. For each piece:

1. Add it to [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES): the source project, its version and commit, the paths taken,
   and its licence.
2. Add the upstream licence text to `LICENSES/`.
3. Annotate the path in `REUSE.toml`. `reuse lint` must pass.

The agent prompts vendored in [agents/](agents/) are an example: they stay under their upstream MIT licence.

## Dependencies

New dependencies must be permissively licensed: `node scripts/check/check-licenses.mjs` fails on a copyleft
dependency. Keep the poster's dependency set small: it runs with the token of the caller's GitHub App.
