# The Rerail module

[Rerail](https://github.com/neralabs/rerail) checks code against a repository's rules: rule documents in
`.rerail/rules/` and rule packs. The `rerail` module ([modules/rerail/](../modules/rerail/)) runs it as one of the
reviewer's [modules](modules.md): deterministic, no model, opt-in. Headless `rerail scan` is an internal-testing
feature of Rerail; its output is the `rerail.scan/1` document described in Rerail's docs. From the Rerail release that
makes it experimental ([neralabs/rerail#667](https://github.com/neralabs/rerail/pull/667)), a scan with no session is
refused unless `RERAIL_EXPERIMENTAL_HEADLESS_SCAN=1`, so the module sets that variable for its scans, and for
approving the packs `.rerail/packs.json` lists (Rerail reads that file only under it), and for nothing else.

## Turning it on

```yaml
    with:
      modules: rerail
      # Optional: an image with Rerail installed, which the modules job runs in. Leave rerail_package empty beside it.
      # rerail_image: ghcr.io/neralabs/rerail:next
      # Optional: the release the reviewer pins when left out. Or a tarball URL, or remote:<version>.
      # rerail_package: "@neralabs/rerail@<version>"
      # Left empty, the base branch's .rerail/packs.json decides; set, they replace its packs (see Which packs run):
      # rerail_packs: "" # Rerail's own packs by id, e.g. "typescript complexity"
      # rerail_repo_packs: "" # packs in this repository, paths from its root, e.g. packs/team
```

With **`rerail_image`**, a public container image with Rerail and Node 24 installed, the modules job runs in that
image and the module installs nothing: it runs the image's `rerail`. With a moving tag, such as
`ghcr.io/neralabs/rerail:next` (each Rerail release on `next`, once it passed a scan of Rerail's own packs), a new
Rerail reaches the caller with no reviewer release, and with no test here: the image's publisher stands behind it.
Set beside `rerail_package` or `RERAIL_PACKAGE_URL`, the module fails rather than pick one.

Otherwise the module installs Rerail ([modules/rerail/install.sh](../modules/rerail/install.sh)) from the first of these
sources:

1. **The secret `RERAIL_PACKAGE_URL`,** for a URL that must not appear in a public file.
2. **`rerail_package: remote:<version>`,** downloaded from the results sink in the secrets `RESULTS_SINK_URL` and
   `RESULTS_SINK_TOKEN`, at `<RESULTS_SINK_URL>/v1/packages/rerail/<version>.tgz`:
   - with the bearer token, over https only;
   - the sink may redirect to a short-lived storage URL, and curl doesn't send the token on to it;
   - the token reaches the install only, through a header file rather than curl's command line;
   - it is unset before `npm` runs, and before the scan.
3. **`rerail_package`** as an npm spec or tarball URL.
4. **The pinned release,** when `rerail_package` is empty: `@neralabs/rerail` at the exact version
   [modules/rerail/pin/package.json](../modules/rerail/pin/package.json) names. It is the release the module is tested
   with: CI installs it the same way, and Dependabot moves the pin, so a new Rerail reaches callers through a reviewer
   release that passed with it.

## Which packs run

The base branch decides, unless the caller names packs. When the base branch's tip has `.rerail/packs.json`
([Rerail's format](https://github.com/neralabs/rerail/blob/main/docs/headless-scan.md#packs-the-repository-lists)):

- **`rerail_packs` and `rerail_repo_packs` both empty:** the scan runs exactly the packs the file lists, besides
  `.rerail/rules/`: published packs at the exact version the file pins, and `path` packs kept in the repository, each
  in its `folders` when the file gives them. The module passes no `--pack`. `--rules-ref` carries the file, with the
  rules and the `path` packs, so a pull request that edits the file is still judged by the base branch's.
- **Either input set:** an experimental pack scan. The inputs' packs are installed and passed as `--pack <id>`, and
  they **replace** the file's packs: none of the file's packs run, only the named ones and `.rerail/rules/`. This
  needs a Rerail release with [neralabs/rerail#829](https://github.com/neralabs/rerail/pull/829); a Rerail that reads
  the file but predates it refuses `--pack` beside the file, and the module fails, naming that release, rather than
  drop the inputs.

The module's log says which of the two it did.

Without the file, the inputs decide, as they did before the file: each pack in `rerail_packs` and `rerail_repo_packs`
is installed and passed to the scans as `--pack <id>`.

Reading the file needs a Rerail release with [neralabs/rerail#736](https://github.com/neralabs/rerail/pull/736), which
came after 0.1.5. The version can't tell, as a build of Rerail's main still says 0.1.5, so the module asks Rerail with
a probe scan of an empty repository whose file lists no packs:

- a Rerail that reads the file reports the packs it ran (`packs`); an older one has no such field;
- with the inputs set, the probe passes their `--pack`s: a Rerail from before #829 refuses them.

With a Rerail that doesn't read the file, the inputs decide even when the file exists. If they are empty too, only
`.rerail/rules/` runs, and the module logs a notice saying so.

## What it does

In **diff mode** (a pull request):

1. **Approval, from the base branch only.** A rule or pack that Rerail hasn't reviewed runs in `log` until a person
   approves it. The module approves, through Rerail's normal mechanism and with no special trust inside Rerail, only
   content from `MODULE_BASE_CHECKOUT`, the base branch's tip:
   - with `.rerail/packs.json` and both inputs empty, each `path` pack the file lists is resolved inside that checkout
     and approved (`rerail rules approve <package name> --repo <base checkout>`); Rerail reads it from `--rules-ref`,
     so it isn't added;
   - otherwise, each path in `rerail_repo_packs` is resolved inside that checkout, added (`rerail packs add`) and
     approved (`rerail rules approve <package name>`);
   - each rule in the base branch's `.rerail/rules/` is approved too (`rerail rules approve <id>`).

   Rerail's own published packs need no approval. Rerail keeps these approvals in a throwaway Rerail home under
   `MODULE_HOME`.
2. **The scan.** It scans the pull request:
   `rerail scan --scope git-diff --base <merge base> --rules-ref <base tip>`, plus `--pack <id>…` for the inputs' packs
   when they decide. With `--rules-ref`, the rules, the packs file and the `path` packs it lists come from the base
   branch, so a pull request can't change the rules it is judged by. Approvals are bound to content, so a pack or rule
   the pull request adds or edits runs unapproved, in `log`.
3. **New or existing.** For the files that have violations, it scans the merge base with the same rules
   (`--paths-from`). It marks each violation **new**, or **existing** if the merge base has one with the same
   fingerprint. The fingerprint is a hash of rule, path and matched text, so a violation that only moved lines still
   matches.
4. **The result.** It writes the module result. Rule modes map to levels: `block` → `error`, `steer` → `warning`,
   `log` → `note`. Rerail's own result goes to `raw/scan.json`, and to `sink.json` as a `scan` record for the results
   sink.

In **repository mode** (a scheduled scan), it approves and scans the branch itself, which is merged code:
`--scope repository --rules-ref <head>`. Every finding is `existing`.

A pack path, in `.rerail/packs.json` or in `rerail_repo_packs`, must be relative to the repository root, without
`..`, and lead to a pack on the base branch. Any of these fails the module, and the review goes on without it:

- an absolute path;
- a `..` step;
- a symlink out of the base checkout;
- a pack that only the pull request has.

## Rule modes and blockers

The rules pass sees only new findings. A new `error` or `warning` (a `block` or `steer` rule) is a blocker, and a
`note` (a `log` rule) is a follow-up at most. On a fresh runner:

| Rules | Run at |
| --- | --- |
| The base branch's `.rerail/rules/` | Their own mode, once the module has approved them |
| The base branch's repository packs: `path` packs in `.rerail/packs.json` when the file decides, else `rerail_repo_packs` | Their own mode, once the module has approved them |
| Rerail's own published packs: listed in `.rerail/packs.json` when the file decides, else `rerail_packs` | Their own mode; they need no approval |
| Any other pack, such as a third party's published pack in `.rerail/packs.json` | `log`, so their violations are follow-ups at most |

## Cost

Two scans per pull request: the change, then the merge base for the files with violations. With `.rerail/packs.json`,
one or two more, of an empty repository, to find out what the installed Rerail does with the file. When the file
decides, each scan fetches its published packs from npm (npm's cache first). On a repository the size of Rerail, this
took a few seconds locally.
