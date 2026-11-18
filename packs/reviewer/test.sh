#!/usr/bin/env bash
# Tests every rule of this pack against its cases (cases/<rule id>.cases.json) with `rerail rules test`, and lists
# where each rule matches in this checkout. Writes nothing. Exits non-zero if a rule is invalid, a case comes out
# wrong, or a rule file and its pack.json entry don't match. RERAIL overrides the launcher (default: rerail on PATH).
#
#   packs/reviewer/test.sh [rule id...]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
RERAIL="${RERAIL:-rerail}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failed=0

# Every rules/<id>.json is listed in pack.json and every listed rule has its file, its id and its cases.
listed="$(jq -r '.rules[].id' "$HERE/pack.json" | sort)"
present="$(for f in "$HERE"/rules/*.json; do basename "$f" .json; done | sort)"
if [[ "$listed" != "$present" ]]; then
  echo "FAIL pack.json lists different rules from rules/:"
  diff <(echo "$listed") <(echo "$present") || true
  failed=1
fi

if (($#)); then ids=("$@"); else ids=(); for f in "$HERE"/rules/*.json; do ids+=("$(basename "$f" .json)"); done; fi

for id in "${ids[@]}"; do
  rule="$HERE/rules/$id.json"
  cases="$HERE/cases/$id.cases.json"
  [[ -f "$rule" && -f "$cases" ]] || { echo "FAIL $id: missing rules/$id.json or cases/$id.cases.json"; failed=1; continue; }
  if [[ "$(jq -r .id "$rule")" != "$id" ]]; then
    echo "FAIL $id: rules/$id.json carries the id $(jq -r .id "$rule")"
    failed=1
    continue
  fi
  if (($(jq '.caught | length' "$cases") < 2 || $(jq '.passed | length' "$cases") < 2)); then
    echo "FAIL $id: needs at least two caught and two passed cases"
    failed=1
  fi
  jq -n --slurpfile rule "$rule" --slurpfile cases "$cases" '{kind: "code", rule: $rule[0], cases: $cases[0]}' \
    >"$WORK/$id.draft.json"
  report="$WORK/$id.report.json"
  "$RERAIL" rules test "$WORK/$id.draft.json" --repo "$REPO" --json >"$report" || true
  if ! jq -e '.valid == true' "$report" >/dev/null 2>&1; then
    echo "FAIL $id: invalid rule"
    jq '.error // .' "$report" 2>/dev/null || cat "$report"
    failed=1
    continue
  fi
  bad="$(jq -r '[.cases[]? | select(.ok != true) | "\(.expected) \(.label)"] | join(", ")' "$report")"
  total="$(jq '[.cases[]?] | length' "$report")"
  if [[ -n "$bad" ]]; then
    echo "FAIL $id: cases wrong: $bad"
    failed=1
  else
    echo "ok   $id: $total cases"
  fi
  jq -r '.repository.matches[]? | "       match \(.path)\(if .line then ":\(.line)" else "" end)"' "$report"
done
exit "$failed"
