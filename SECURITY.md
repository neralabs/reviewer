# Security policy

Reviewer runs in other organizations' pull request workflows. It reads untrusted pull request content with a model
API key in reach, and it posts reviews that can count toward a merge. We treat reports about it accordingly.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/neralabs/reviewer/security/advisories/new) (the repository's
**Security** tab, then **Report a vulnerability**). Include a description, the affected tag, and steps to reproduce.

Please do not open a public issue or disclose the vulnerability until it has been fixed.

## What to expect

- We acknowledge your report within **two business days**.
- We keep you informed while we investigate and fix it, and agree a disclosure date with you.
- We credit you in the advisory and the release notes, if you wish.

## Supported versions

Callers pin a release tag ([docs/versioning.md](docs/versioning.md)). Security fixes ship as a new release, and only
the **latest release tag** is supported. Earlier tags receive no fixes; move your pin to the latest to get them.

## What's in scope

The reviewer's attack surface, which is where we most want reports:

- **The reusable workflow** ([.github/workflows/review.yml](.github/workflows/review.yml)). It runs on
  `pull_request_target`, `issue_comment` and review-comment events in the caller's repository, with the caller's
  secrets: the GitHub App key the reviewer posts as, and the model provider's API key. Anything that lets pull request
  content run code in a job that holds a secret, reach a secret, or widen a token is in scope.
- **The model reading untrusted content.** The model reads the pull request's diff, files, description, commits and
  CI logs, any of which can carry prompt injection. It runs with no shell, no network tools and no GitHub token
  ([scripts/run-claude.sh](scripts/run-claude.sh)). An escape from that lockdown, or a way to make it leak its
  credential or approve a pull request it should not, is in scope.
- **The poster** ([poster/](poster/)). It turns the model's output into a GitHub review, and it alone decides whether
  that review approves. A way to forge its state, mention or notify people, load remote content, post a credential, or
  get an approval past its policy is in scope.
- **The transcript artifact.** `reviewer-transcript` keeps the model session for 14 days and is readable by anyone who
  can read the caller's Actions runs. A credential that survives redaction is in scope.

How these layers fit together is in [docs/security-model.md](docs/security-model.md). What leaves the caller's
repository is in [docs/privacy.md](docs/privacy.md).

Out of scope: a model finding that is merely wrong or missing (open a
[bad review](https://github.com/neralabs/reviewer/issues/new?template=2-bad-review.yml) issue), and weaknesses in a
caller's own configuration, such as a model key with more rights than the reviewer needs.
