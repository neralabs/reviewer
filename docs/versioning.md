# Versioning and releases

## Tags

Releases are semver tags, `vX.Y.Z`, on this repository. A tag is never moved or deleted once published: a fix is a new
tag.

## Pinning

A caller workflow pins one tag in two places, and they must match:

```yaml
jobs:
  review:
    uses: neralabs/reviewer/.github/workflows/review.yml@vX.Y.Z
    with:
      reviewer_ref: vX.Y.Z
```

`uses:` selects the workflow. `reviewer_ref` selects the scripts, prompts and poster the workflow checks out. The full
caller is in [templates/caller.yml](../templates/caller.yml), and every input in
[docs/configuration.md](configuration.md).

Pin a tag, not `main` or a branch: a review can approve a pull request, so what runs should change only when you
change the pin. Dependabot's `github-actions` updates can move the `uses:` pin for you; update `reviewer_ref` in the
same commit.

## What is breaking

A change is breaking, and bumps the major version, when an existing caller has to change something to keep working the
same way:

- **Caller inputs and secrets**: one is added as required, removed, renamed, or changes meaning or default.
- **`REVIEW.md` settings**: a setting is removed or renamed, or its format or meaning changes.
- **The findings schema** ([schema/](../schema/)): a field is removed or renamed, or its type or meaning changes.
- **Command syntax**: a comment command is removed, renamed, or takes different arguments.

New optional inputs, settings, fields and commands are minor releases. Fixes, prompt changes and dependency updates
are patch releases. Before 1.0.0, a minor version may break, and its release notes say how.

Model output is not covered: the same tag can review the same change differently. Pin `model` to a specific model id, not an
alias, to keep the model itself from changing.

## Changelog

Each release has a GitHub Release with its notes: what changed, and for a breaking change how to upgrade. See
[Releases](https://github.com/neralabs/reviewer/releases).

## Security fixes

Only the latest tag gets them ([SECURITY.md](../SECURITY.md#supported-versions)).
