#!/usr/bin/env bash
# Installs Rerail for the rules job (review.yml) and the scan job (scan.yml), then adds the caller's rule packs.
#
#   RERAIL_PACKAGE_URL   secret; when set, installed from as is (npm spec or tarball URL), ahead of PACKAGE
#   PACKAGE              the rerail_package input: an npm spec, a tarball URL, or remote:<version>
#   PACKS                space-separated rule pack ids, each added with `rerail packs add`
#   RERAIL_REMOTE_URL    for remote:<version>: the Rerail remote that serves the tarball at
#   RERAIL_REMOTE_TOKEN  <RERAIL_REMOTE_URL>/v1/packages/rerail/<version>.tgz, with this bearer token
#
# remote:<version> downloads over https only. The token goes to curl in a header file, not on its command line,
# and curl doesn't send it on to the host a redirect points at (a short-lived storage URL). The secrets are unset
# before npm runs.
set -euo pipefail

source="${RERAIL_PACKAGE_URL:-${PACKAGE:-}}"
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
  if [ -z "${RERAIL_REMOTE_URL:-}" ] || [ -z "${RERAIL_REMOTE_TOKEN:-}" ]; then
    echo "::error::rerail_package remote:<version> needs the secrets RERAIL_REMOTE_URL and RERAIL_REMOTE_TOKEN"
    exit 1
  fi
  if [[ "$RERAIL_REMOTE_URL" != https://* ]]; then
    echo "::error::RERAIL_REMOTE_URL must be https"
    exit 1
  fi
  dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rerail.XXXXXX")"
  headers="$dir/headers"
  (umask 077 && printf 'Authorization: Bearer %s\n' "$RERAIL_REMOTE_TOKEN" > "$headers")
  tarball="$dir/rerail-$version.tgz"
  status=0
  curl --fail --silent --show-error --location --proto '=https' --max-redirs 3 \
    --retry 3 --retry-all-errors --connect-timeout 10 --max-time 300 \
    --header "@$headers" --output "$tarball" \
    "${RERAIL_REMOTE_URL%/}/v1/packages/rerail/$version.tgz" || status=$?
  rm -f "$headers"
  if [ "$status" -ne 0 ]; then
    echo "::error::could not download Rerail $version from the Rerail remote (curl exit $status)"
    exit 1
  fi
  source="$tarball"
fi

# Nothing after this needs the remote, so neither npm nor Rerail's install scripts get its token.
unset RERAIL_REMOTE_URL RERAIL_REMOTE_TOKEN RERAIL_PACKAGE_URL
# Scripts stay on: Rerail's postinstall places its native engine.
npm install --global "$source"
rerail --version
for pack in ${PACKS:-}; do
  rerail packs add "$pack"
done
