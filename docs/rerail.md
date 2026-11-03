# The Rerail module

[Rerail](https://github.com/neralabs/rerail) checks code against a repository's rules: rule documents in
`.rerail/rules/` and rule packs. The `rerail` module ([modules/rerail/](../modules/rerail/)) runs it as one of the
reviewer's [modules](modules.md): deterministic, no model, opt-in. Headless `rerail scan` is an internal-testing
feature of Rerail; its output is the `rerail.scan/1` document described in Rerail's docs.

## Turning it on

```yaml
    with:
      modules: rerail
      rerail_package: "@neralabs/rerail@<version>" # or a tarball URL, or remote:<version>
      rerail_packs: "" # Rerail's own packs by id, e.g. "typescript complexity"
      rerail_repo_packs: "" # packs in this repository, paths from its root, e.g. packs/team
```

The module installs Rerail ([modules/rerail/install.sh](../modules/rerail/install.sh)) from the first of these
sources:

1. **The secret `RERAIL_PACKAGE_URL`,** for a URL that must not appear in a public file.
2. **`rerail_package: remote:<version>`,** downloaded from the results sink in the secrets `RESULTS_SINK_URL` and
   `RESULTS_SINK_TOKEN`, at `<RESULTS_SINK_URL>/v1/packages/rerail/<version>.tgz`:
   - with the bearer token, over https only;
   - the sink may redirect to a short-lived storage URL, and curl doesn't send the token on to it;
   - the token reaches the install only, through a header file rather than curl's command line;
   - it is unset before `npm` runs, and before the scan.
3. **`rerail_package`** as an npm spec or tarball URL.

## What it does

In **diff mode** (a pull request):

1. **Approval, from the base branch only.** A rule or pack that Rerail hasn't reviewed runs in `log` until a person
   approves it. The module approves, through Rerail's normal mechanism and with no special trust inside Rerail, only
   content from `MODULE_BASE_CHECKOUT`, the base branch's tip:
   - each path in `rerail_repo_packs` is resolved inside that checkout, added (`rerail packs add`) and approved
     (`rerail rules approve <package name>`);
   - each rule in the base branch's `.rerail/rules/` is approved too (`rerail rules approve <id>`).

   Rerail keeps these approvals in a throwaway Rerail home under `MODULE_HOME`.
2. **The scan.** It scans the pull request:
   `rerail scan --scope git-diff --base <merge base> --rules-ref <base tip> --pack <id>…`. With `--rules-ref`, the rules
   come from the base branch, so a pull request can't change the rules it is judged by. Approvals are bound to
   content, so a pack or rule the pull request adds or edits runs unapproved, in `log`.
3. **New or existing.** For the files that have violations, it scans the merge base with the same rules
   (`--paths-from`). It marks each violation **new**, or **existing** if the merge base has one with the same
   fingerprint. The fingerprint is a hash of rule, path and matched text, so a violation that only moved lines still
   matches.
4. **The result.** It writes the module result. Rule modes map to levels: `block` → `error`, `steer` → `warning`,
   `log` → `note`. Rerail's own result goes to `raw/scan.json`, and to `sink.json` as a `scan` record for the results
   sink.

In **repository mode** (a scheduled scan), it approves and scans the branch itself, which is merged code:
`--scope repository --rules-ref <head>`. Every finding is `existing`.

A pack path must be relative to the repository root, without `..`, and lead to a pack on the base branch. Any of these
fails the module, and the review goes on without it:

- an absolute path;
- a `..` step;
- a symlink out of the base checkout;
- a pack that only the pull request has.

## Rule modes and blockers

The rules pass sees only new findings. A new `error` or `warning` (a `block` or `steer` rule) is a blocker, and a
`note` (a `log` rule) is a follow-up at most. On a fresh runner:

| Rules | Run at |
| --- | --- |
| The base branch's `.rerail/rules/` and packs in `rerail_repo_packs` | Their own mode, once the module has approved them |
| Rerail's own published packs (`rerail_packs`, from npm) | Their own mode; they need no approval |
| Any other pack | `log`, so their violations are follow-ups at most |

## Cost

Two scans per pull request: the change, then the merge base for the files with violations. On a repository the size
of Rerail, this took a few seconds locally.
