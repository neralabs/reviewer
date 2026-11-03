# Rerail rules

[Rerail](https://github.com/neralabs/rerail) checks code against a repository's rules: rule documents in
`.rerail/rules/` and rule packs. The reviewer can use those rules in two ways, both optional and off by default:

- **Rule-aware review:** every review starts with a deterministic `rerail scan` of the pull request, and the model
  reviews with the result. A violation the PR brings in, of a rule in `block` or `steer` mode, is a blocker that
  names its rule.
- **Scheduled scan:** a second reusable workflow, `scan.yml`, scans a whole branch on a schedule and keeps the result
  as an artifact, as Rerail's own result and as a findings document.

Either can also send its result to a Rerail remote (the sink protocol, below). That is off unless the caller turns it
on; see [privacy.md](privacy.md).

Headless `rerail scan` is an internal-testing feature of Rerail. Its output is the `rerail.scan/1` JSON document
described in Rerail's docs.

## Rule-aware review

Turn it on in the caller ([templates/caller.yml](../templates/caller.yml)):

```yaml
    with:
      rerail_package: "@neralabs/rerail@<version>" # or a tarball URL
      rerail_packs: "" # space-separated pack ids, each installed with `rerail packs add`
      rerail_repo_packs: "" # packs in this repository, paths from its root, e.g. packs/team
```

Rerail is installed by [scripts/install-rerail.sh](../scripts/install-rerail.sh), from the first of:

1. the secret `RERAIL_PACKAGE_URL`, for a URL that must not appear in a public file;
2. `rerail_package: remote:<version>`: downloaded from the Rerail remote in the secrets `RERAIL_REMOTE_URL` and
   `RERAIL_REMOTE_TOKEN`, at `<RERAIL_REMOTE_URL>/v1/packages/rerail/<version>.tgz` with the bearer token, over https
   only. The remote may redirect to a short-lived storage URL; curl doesn't send the token on to it. The token reaches
   the install step only, through a header file rather than curl's command line, and is unset before `npm` runs;
3. `rerail_package` as an npm spec or tarball URL.

The `rules` job runs after the gate and before the review, with no keys and a read-only token:

1. checks out the PR head, as data, and installs Rerail;
2. scans the PR's changes: `rerail scan --scope git-diff --base <merge base> --rules-ref <base branch tip> --pack <id>…`.
   With `--rules-ref`, the rules come from `.rerail/rules/` on the base branch and run at their own mode, so a PR
   can't rewrite or switch off the rules it is judged by;
3. scans the merge base, with the same rules, for the files that have violations
   (`--scope repository --paths-from <list>`), and marks each head violation **new** or **already on the merge base**
   by its fingerprint (a stable hash of rule, path and matched text, so a violation that only moved lines still
   matches);
4. hands `work/rules/` (the scan, the merge-base scan and a summary) to the review job.

`prepare` turns that into `context/rerail.md` (rules checked, new violations, violations already on the base) and
`context/rerail-scan.json`. The review bar ([team-context.md](../skill/review/team-context.md)) says:

- a new violation of a `block` or `steer` rule is a **blocker**, with the rule's id in the finding's `ruleId`;
- a new violation of a `log` rule is a follow-up at most (see [Rule modes in CI](#rule-modes-in-ci));
- violations already on the merge base aren't findings;
- the model checks each violation against the code like any other finding, and drops a plain false positive.

The posted finding says which rule it breaks. The poster keeps a finding's `ruleId` only if the run's scan checked
that rule (the manifest lists them), so the model can't cite a rule that doesn't exist.

A failed install or scan never stops the review. `context/rerail.md` then says the scan didn't complete, and the
model reviews without it. Two scans add a few seconds on a typical PR; the merge-base scan covers only files with
violations.

### Approval: base branch only

A rule or pack that Rerail hasn't reviewed runs in `log` until a person approves it. In CI, the `rules` job approves
through Rerail's normal mechanism, with no special trust inside Rerail, and only content from the **base branch**:

1. it checks out the base branch's tip next to the PR (`work/rules-src`);
2. for each path in `rerail_repo_packs` (a pack that lives in the repository, such as `packs/team`), it resolves the
   path inside that checkout, adds the pack (`rerail packs add <base checkout>/<path>`) and approves it
   (`rerail rules approve <package name>`);
3. it approves each rule in the base branch's `.rerail/rules/` (`rerail rules approve <id>`);
4. it scans the PR head with those packs (`--pack <id>`) and `--rules-ref <base tip>`.

Approvals are bound to content, so a pack or rule the PR adds or edits runs unapproved, in `log`. A pack path must
be relative to the repository root, without `..`, and lead to a pack on the base branch: an absolute path, a `..`
step or a symlink out of the base checkout fails the scan, and so does a pack only the PR has. The PR's checkout is
never a source of rules, packs or approvals.

The scheduled scan does the same for the branch it scans, which is merged code.

### Rule modes in CI

Only `block` and `steer` violations can be blockers, and a rule runs at its own mode only once it is approved:

- rules in the base branch's `.rerail/rules/` and packs in `rerail_repo_packs`: approved by the steps above;
- Rerail's own published packs (`rerail_packs`, from npm): need no approval;
- any other pack (a third-party one, or a folder or tarball added some other way): runs in `log`, so its violations
  are follow-ups at most.

## Scheduled scan

[templates/scan-caller.yml](../templates/scan-caller.yml) calls `.github/workflows/scan.yml` on a schedule:

```yaml
jobs:
  scan:
    uses: neralabs/reviewer/.github/workflows/scan.yml@<tag>
    with:
      reviewer_ref: <tag>
      rerail_package: "@neralabs/rerail@<version>"
```

It checks out the branch (`ref`, or the ref that triggered the run), runs
`rerail scan --scope repository --rules-ref HEAD --json` with the branch's merged rules, and uploads the `rerail-scan`
artifact (kept 30 days):

- `scan.json`: Rerail's `rerail.scan/1` result;
- `findings.json`: the same violations as a document in the reviewer's [findings schema](../schema/findings.schema.json),
  every finding with its `ruleId`. The level comes from the rule's mode: `block` is a blocker, `steer` a follow-up,
  `log` a nit. The risk is high with any `block` violation, medium with any `steer` one, low otherwise.

The workflow's `violations` output is the count.

| Input | Default | Meaning |
|---|---|---|
| `reviewer_ref` | `main` | Ref of neralabs/reviewer to load the poster from; the same as the `@ref` in `uses:`. |
| `ref` | `""` | Branch, tag or SHA to scan. Empty: the triggering ref (the default branch on `schedule`). |
| `rerail_package` | `""` | What to install Rerail from: an npm spec, a tarball URL or `remote:<version>` (above). Required unless the secret `RERAIL_PACKAGE_URL` is set. |
| `rerail_packs` | `""` | Rule packs to scan with, space-separated. |
| `rerail_repo_packs` | `""` | Packs in the repository, as paths from its root; approved from the scanned branch. |
| `send_results` | `false` | Send the result to the Rerail remote. |

## Sending results to a Rerail remote

With `send_results: true` and the secrets `RERAIL_REMOTE_URL` and `RERAIL_REMOTE_TOKEN`, a `send` job posts the scan
result to `<RERAIL_REMOTE_URL>/v1/batches` with `Authorization: Bearer <token>`, as one NDJSON batch of Rerail's sink
protocol:

1. the batch header: `{"type":"batch","protocol":1,"batchId","machineId","machineLabel","rerailVersion","sentAt"}`.
   The machine is the calling repository's GitHub Actions: `machineLabel` is `github-actions:<owner>/<repo>` and
   `machineId` a UUID derived from it, so give each calling repository its own token. `batchId` is derived from the
   repository, run, attempt and scan, so a retried send is stored once;
2. a `scan` record: the `rerail.scan/1` result plus `"type":"scan"` and `"id": <scanId>`.

The job retries server errors, rate limits and timeouts with backoff, and gives up at once on `401`, `413` or another
`4xx`. Its messages never include the URL or the token. Both are secrets, so no endpoint sits in a public caller
file. The job holds only those two: no model key, no GitHub token, and nothing the model wrote. A failed send doesn't
affect the review.
