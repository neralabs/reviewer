#!/usr/bin/env bash
# Rerail module: installs Rerail, then adds the caller's rule packs (by id).
#
#   RERAIL_PACKAGE_URL   secret; when set, installed from as is (npm spec or tarball URL), ahead of RERAIL_PACKAGE
#   RERAIL_PACKAGE       the rerail_package input: an npm spec, a tarball URL, or remote:<version>
#   RERAIL_PACKS         space-separated rule pack ids, each added with `rerail packs add`
#   RESULTS_SINK_URL     for remote:<version>: the results sink, which also serves the Rerail tarball at
#   RESULTS_SINK_TOKEN   <RESULTS_SINK_URL>/v1/packages/rerail/<version>.tgz, with this bearer token
#
# remote:<version> downloads over https only. The token goes to curl in a header file, not on its command line,
# and curl doesn't send it on to the host a redirect points at (a short-lived storage URL). The secrets are unset
# before npm runs.
set -euo pipefail

source="${RERAIL_PACKAGE_URL:-${RERAIL_PACKAGE:-}}"
if [ -z "$source" ]; then
  echo "::error::set rerail_package, or the secret RERAIL_PACKAGE_URL"
  exit 1
fi

if [ -z "${RERAIL_PACKAGE_URL:-}" ] && [[ "$source" == remote:* ]]; then
  version="${source#remote:}"
  if ! [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]]; then
    echo "::error::rerail_package remote:<version> needs a plain version, such as remote:0.2.0"
    exit 1
  fi
  if [ -z "${RESULTS_SINK_URL:-}" ] || [ -z "${RESULTS_SINK_TOKEN:-}" ]; then
    echo "::error::rerail_package remote:<version> needs the secrets RESULTS_SINK_URL and RESULTS_SINK_TOKEN"
    exit 1
  fi
  if [[ "$RESULTS_SINK_URL" != https://* ]]; then
    echo "::error::RESULTS_SINK_URL must be https"
    exit 1
  fi
  dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rerail.XXXXXX")"
  headers="$dir/headers"
  (umask 077 && printf 'Authorization: Bearer %s\n' "$RESULTS_SINK_TOKEN" > "$headers")
  tarball="$dir/rerail-$version.tgz"
  status=0
  curl --fail --silent --show-error --location --proto '=https' --max-redirs 3 \
    --retry 3 --retry-all-errors --connect-timeout 10 --max-time 300 \
    --header "@$headers" --output "$tarball" \
    "${RESULTS_SINK_URL%/}/v1/packages/rerail/$version.tgz" || status=$?
  rm -f "$headers"
  if [ "$status" -ne 0 ]; then
    echo "::error::could not download Rerail $version from the results sink (curl exit $status)"
    exit 1
  fi
  source="$tarball"
fi

# Nothing after this needs the remote, so neither npm nor Rerail's install scripts get its token.
unset RESULTS_SINK_URL RESULTS_SINK_TOKEN RERAIL_PACKAGE_URL
# Scripts stay on: Rerail's postinstall places its native engine.
npm install --global "$source"
rerail --version
for pack in ${RERAIL_PACKS:-}; do
  rerail packs add "$pack"
done
