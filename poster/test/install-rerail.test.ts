import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("../../scripts/install-rerail.sh", import.meta.url).pathname;

/**
 * Runs scripts/install-rerail.sh with fake curl, npm and rerail first on PATH. Each logs its arguments; curl also
 * logs the header file it was given and writes the --output file, or fails when FAKE_CURL_FAIL is set.
 */
function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "install-rerail-"));
  const log = join(dir, "calls.log");
  const fake = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  fake(
    "curl",
    `[ -n "\${FAKE_CURL_FAIL:-}" ] && exit 22
while [ $# -gt 0 ]; do
  case "$1" in
    --header) echo "header-file $(cat "\${2#@}")" >> "${log}"; shift ;;
    --output) echo tarball > "$2"; shift ;;
  esac
  shift
done`,
  );
  fake("npm", `echo "npm-env \${RERAIL_REMOTE_TOKEN:-unset} \${RERAIL_PACKAGE_URL:-unset}" >> "${log}"`);
  fake("rerail", "");
  const res = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, ...env },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    // nothing ran
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: res.status, out: res.stdout + res.stderr, calls };
}

const REMOTE = { RERAIL_REMOTE_URL: "https://sink.example/", RERAIL_REMOTE_TOKEN: "tok-123" };

test("an npm spec or URL installs as given, then each pack is added", () => {
  const { status, calls } = run({ PACKAGE: "@neralabs/rerail@0.2.0", PACKS: "rerail example/node" });
  assert.equal(status, 0);
  assert.deepEqual(calls, ["npm install --global @neralabs/rerail@0.2.0", "npm-env unset unset", "rerail --version", "rerail packs add rerail", "rerail packs add example/node"]);
});

test("the secret RERAIL_PACKAGE_URL wins over the input, even a remote: one", () => {
  const { status, calls } = run({ PACKAGE: "remote:0.2.0", RERAIL_PACKAGE_URL: "https://files.example/r.tgz", ...REMOTE });
  assert.equal(status, 0);
  assert.equal(calls[0], "npm install --global https://files.example/r.tgz");
  assert.ok(!calls.some((c) => c.startsWith("curl")));
});

test("remote:<version> downloads from the remote with the token in a header file, then installs the file", () => {
  const { status, calls, out } = run({ PACKAGE: "remote:0.1.1-w2.0", ...REMOTE });
  assert.equal(status, 0, out);
  const curl = calls.find((c) => c.startsWith("curl "))!;
  assert.match(curl, / https:\/\/sink\.example\/v1\/packages\/rerail\/0\.1\.1-w2\.0\.tgz$/);
  assert.match(curl, /--proto =https/);
  assert.doesNotMatch(curl, /tok-123/); // not on the command line
  assert.ok(calls.includes("header-file Authorization: Bearer tok-123"));
  assert.match(calls.find((c) => c.startsWith("npm "))!, /^npm install --global .*\/rerail-0\.1\.1-w2\.0\.tgz$/);
  assert.ok(calls.includes("npm-env unset unset"), "npm and install scripts don't see the secrets");
});

test("remote:<version> refuses an odd version, missing secrets, plain http and a failed download", () => {
  for (const [env, message] of [
    [{ PACKAGE: "remote:../../x", ...REMOTE }, /plain version/],
    [{ PACKAGE: "remote:", ...REMOTE }, /plain version/],
    [{ PACKAGE: "remote:0.2.0" }, /needs the secrets/],
    [{ PACKAGE: "remote:0.2.0", ...REMOTE, RERAIL_REMOTE_URL: "http://sink.example" }, /must be https/],
    [{ PACKAGE: "remote:0.2.0", ...REMOTE, FAKE_CURL_FAIL: "1" }, /could not download Rerail 0\.2\.0 from the Rerail remote \(curl exit 22\)/],
  ] as const) {
    const { status, out, calls } = run(env);
    assert.equal(status, 1, out);
    assert.match(out, message);
    assert.doesNotMatch(out, /tok-123/);
    assert.ok(!calls.some((c) => c.startsWith("npm ")));
  }
});

test("no package and no secret is an error", () => {
  const { status, out } = run({});
  assert.equal(status, 1);
  assert.match(out, /set rerail_package/);
});
