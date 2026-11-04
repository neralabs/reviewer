#!/usr/bin/env bash
# Example module "todo" (docs/modules.md): a note for every line with TODO in the checkout. A finding is new
# when the merge base has no such line in that file. Deterministic: no network, no model, no secrets.
set -euo pipefail
cd "$MODULE_CHECKOUT"
findings=""
while IFS= read -r match; do
  path="${match%%:*}" rest="${match#*:}"
  line="${rest%%:*}" text="${rest#*:}"
  fingerprint="$(printf '%s\n%s' "$path" "$text" | git hash-object --stdin)"
  state=existing
  if [ "$MODULE_MODE" = diff ] && ! git grep -qF -e "$text" "$MODULE_MERGE_BASE" -- "$path" 2>/dev/null; then state=new; fi
  findings+="${findings:+,}{\"module\":\"todo\",\"checkId\":\"no-todo\",\"level\":\"note\",\"path\":$(jq -Rn --arg p "$path" '$p'),"
  findings+="\"start\":{\"line\":$line,\"column\":1},\"end\":{\"line\":$((line + 1)),\"column\":1},"
  findings+="\"message\":\"Resolve the TODO, or track it.\",\"fingerprint\":\"$fingerprint\",\"state\":\"$state\"}"
done < <(git grep -n -I -e TODO HEAD -- . | sed 's/^HEAD://' || true)
cat >"$MODULE_OUT/results.json" <<EOF
{"schema": "reviewer.module-results/1", "module": "todo", "version": "1", "mode": "$MODULE_MODE", "status": "completed",
 "checks": [{"id": "no-todo", "level": "note"}], "findings": [$findings]}
EOF
