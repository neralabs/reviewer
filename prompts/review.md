Review pull request {{repo}}#{{pr}} at head `{{head_sha}}` against `{{base_ref}}` (merge base `{{merge_base}}`).

Follow the review procedure in your system prompt, from step 1. Scope: {{scope}}. Specialists by file type: {{specialists}}. Summary only: {{summary_only}}.

Start with `context/README.md`. If `context/prior-findings.json` lists findings from an earlier review, give each a status in `priorFindings` and don't repeat the open ones in `findings`. If `context/feedback.md` exists, take it into account as step 5 describes.

When you are done, return the structured output and nothing else.
