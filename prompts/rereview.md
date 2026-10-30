Re-review pull request {{repo}}#{{pr}} at head `{{head_sha}}` against `{{base_ref}}` (merge base `{{merge_base}}`). The last review covered `{{last_reviewed_sha}}`. Scope: {{scope}}.

Follow the review procedure in your system prompt, with step 5 driving it:

1. Read `context/README.md`, `context/prior-findings.json` (with the replies on each finding's thread) and `context/feedback.md` if it exists.
2. Give every prior finding a status in `priorFindings`: fixed, open or moot, with evidence from the head.
3. Review `context/delta.patch` for new problems, fanning out as step 2 describes. Specialists by file type: {{specialists}}. Read beyond the delta only where the feedback or a prior finding reopens it. If `delta.patch` is empty (no new commits), don't fan out: this head was already reviewed, so re-check the prior findings and the feedback yourself, and report a new finding only where the feedback or a re-check turns one up.
4. Put only new problems in `findings`.

When you are done, return the structured output and nothing else.
