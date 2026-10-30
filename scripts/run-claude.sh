#!/usr/bin/env bash
# Runs Claude Code headless for one review. Called by the review job with the
# working directory set to work/ (pr/, base/, context/, agents.json).
#
# Lockdown, in layers:
#   --restricted          no Bash or other code-running tools, no WebFetch; user,
#                         project and local settings files ignored (so a PR's
#                         .claude/settings.json can't add hooks or env); file
#                         tools confined to the working directory.
#   --strict-mcp-config   no MCP servers.
#   dontAsk + no prompts  anything not pre-approved is denied, never asked.
#   --disallowedTools     no edits, no web search, no ScheduleWakeup.
#   CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
#                         subagents run in the foreground, so each Agent call returns its report and the
#                         session ends when the review does. In the background (the default) the main
#                         agent emitted findings before its subagents reported, then scheduled a
#                         20-minute wakeup and idled on the runner.
# The process holds one model credential and nothing else secret: no GitHub token. Scope that key to
# invoking the reviewer's model only.
#
# Needs: REVIEWER_PROVIDER (anthropic or bedrock), MODEL (a pinned model id; on Bedrock also an inference
# profile), MAX_BUDGET_USD, and the provider's credential: ANTHROPIC_API_KEY for anthropic;
# AWS_BEARER_TOKEN_BEDROCK and AWS_REGION for bedrock.
set -euo pipefail

home="$(cd "$(dirname "$0")/.." && pwd)"
summary="${GITHUB_STEP_SUMMARY:-/dev/stderr}"

fail() {
  echo "::error::$1"
  exit 1
}

[[ -n "${MODEL:-}" ]] || fail "The caller must set the model input to a pinned model id."
case "${REVIEWER_PROVIDER:-}" in
  anthropic)
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] || fail "provider is anthropic but REVIEWER_ANTHROPIC_API_KEY is empty. Pass it in the caller's secrets."
    unset AWS_BEARER_TOKEN_BEDROCK AWS_REGION CLAUDE_CODE_USE_BEDROCK
    ;;
  bedrock)
    [[ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ]] || fail "provider is bedrock but REVIEWER_BEDROCK_API_KEY is empty. Pass it in the caller's secrets."
    [[ -n "${AWS_REGION:-}" ]] || fail "provider is bedrock but the aws_region input is empty."
    unset ANTHROPIC_API_KEY
    export CLAUDE_CODE_USE_BEDROCK=1
    ;;
  *)
    fail "The provider input must be anthropic or bedrock, not '${REVIEWER_PROVIDER:-}'."
    ;;
esac

# Readable view of the stream-json session: main and subagent text, each tool call with its input, and
# tool results, cut to keep it skimmable. Printed to the step log as it happens (watch the Review step of
# the running job), and written to transcript.md for the reviewer-transcript artifact.
# shellcheck disable=SC2016 # a jq program: $who and $n are jq variables, not shell ones
render='
  def cut($n): if (. | length) > $n then .[0:$n] + " …" else . end;
  (if .parent_tool_use_id then "subagent" else "main" end) as $who |
  if .type == "assistant" then
    .message.content[]? |
    if .type == "thinking" then "\n_\($who) is thinking:_ \(.thinking // "" | gsub("\n"; " ") | cut(400))"
    elif .type == "text" then "\n**\($who)**: \(.text)"
    elif .type == "tool_use" then "\n`\($who)` → **\(.name)** `\(.input | tojson | cut(300))`"
    else empty end
  elif .type == "user" then
    .message.content[]? | select(type == "object" and .type == "tool_result") |
    "\n> \((.content | if type == "array" then map(.text? // "") | join(" ") else tostring end) | gsub("\n"; " ") | cut(500))"
  elif .type == "result" then
    "\n---\n**Result:** \(.subtype), \(.num_turns) turns, \((.duration_ms // 0) / 1000 | floor)s, $\(.total_cost_usd)"
  else empty end
'

export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1

set +e
claude -p "$(cat context/prompt.md)" \
  --restricted \
  --strict-mcp-config \
  --permission-mode dontAsk \
  --permission-prompts none \
  --allowedTools "Read,Grep,Glob,Agent" \
  --disallowedTools "Edit,Write,NotebookEdit,WebFetch,WebSearch,ScheduleWakeup" \
  --agents agents.json \
  --append-system-prompt "$(cat "$home/skill/review/SKILL.md")" \
  --json-schema "$(cat "$home/schema/findings.schema.json")" \
  --output-format stream-json \
  --verbose \
  --forward-subagent-text \
  --no-session-persistence \
  --model "$MODEL" \
  --max-budget-usd "$MAX_BUDGET_USD" |
  tee transcript.jsonl |
  { jq --unbuffered -r "$render" 2>/dev/null || cat >/dev/null; } # if rendering breaks, keep draining so claude isn't cut off
status=${PIPESTATUS[0]}
set -e

jq -r "$render" transcript.jsonl >transcript.md 2>/dev/null || true

# Subagents run in the background: the main session ends a turn, then resumes when they report. So the
# stream can hold several result lines, and the structured output need not be on the last one (a final
# wakeup turn can end without it). Cost and turns come from the last result; findings from the last
# result that carries structured output.
jq -c 'select(.type == "result")' transcript.jsonl 2>/dev/null | tail -n 1 >claude-result.json || true
jq -c 'select(.type == "result" and (.structured_output | type) == "object") | .structured_output' transcript.jsonl 2>/dev/null |
  tail -n 1 >findings.json || true

jq -r '"### Claude Code\n\n| Result | Turns | Duration | Cost |\n|---|---|---|---|\n| \(.subtype // "?") | \(.num_turns // "?") | \((.duration_ms // 0) / 1000 | floor)s | $\(.total_cost_usd // "?") |"' \
  claude-result.json >>"$summary" 2>/dev/null || echo "Claude Code wrote no JSON result (exit $status)." >>"$summary"
echo "Full session: the \`reviewer-transcript\` artifact of this run (\`transcript.md\` to read, \`transcript.jsonl\` raw)." >>"$summary"

if ! jq -e 'objects' findings.json >/dev/null 2>&1; then
  echo "::error::Claude Code returned no structured output (exit $status, result $(jq -r '.subtype // "unknown"' claude-result.json 2>/dev/null || echo unreadable))."
  jq -r '.result // empty' claude-result.json 2>/dev/null | head -c 4000 || true
  exit 1
fi
