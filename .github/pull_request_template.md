<!--
From a fork, this pull request is a proposal: it gets no CI, and a maintainer who takes it ports it to a branch here
and closes this one with a link. Contributors open pull requests from branches here:
https://github.com/neralabs/reviewer/blob/main/CONTRIBUTING.md#how-contribution-works
-->

Fixes #

## What and why

## How you tested it

## Checklist

<!-- From https://github.com/neralabs/reviewer/blob/main/CONTRIBUTING.md#before-you-open-a-pull-request -->

- [ ] It links the issue where the approach was agreed, or it's a change that needs none (typo, doc fix, a bug fix
      with its test)
- [ ] In `poster/`: `npx tsc --noEmit` and `npm test` pass
- [ ] `actionlint` and `shellcheck scripts/*.sh` pass
- [ ] `reuse lint`, `node scripts/check/check-licenses.mjs` and `node scripts/check/check-internal-refs.mjs` pass
- [ ] Tests cover the behavior this changes, and the docs that describe it are updated
- [ ] If it touches the verdict policy, the poster, the schema, the workflow or `REVIEW.md` parsing, it says so above
      and has a second maintainer's review
      ([security-sensitive changes](https://github.com/neralabs/reviewer/blob/main/CONTRIBUTING.md#security-sensitive-changes))
- [ ] Caller inputs and secrets, `REVIEW.md` settings, the findings schema and the commands keep working, or this says
      above what changes and how callers upgrade
