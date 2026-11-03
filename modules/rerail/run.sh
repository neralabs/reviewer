#!/usr/bin/env bash
# Rerail module (docs/modules.md): installs Rerail, then scans and writes $MODULE_OUT/results.json (run.ts).
# Module inputs: RERAIL_PACKAGE or RERAIL_PACKAGE_URL, RERAIL_PACKS, RERAIL_REPO_PACKS; RESULTS_SINK_URL and
# RESULTS_SINK_TOKEN only for RERAIL_PACKAGE=remote:<version>. Everything Rerail keeps lives in $MODULE_HOME.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export RERAIL_HOME="$MODULE_HOME/rerail-home"
bash "$here/install.sh"
# install.sh needed the sink's secrets to download Rerail; nothing after it does.
unset RESULTS_SINK_URL RESULTS_SINK_TOKEN RERAIL_PACKAGE_URL
exec node "$here/run.ts"
