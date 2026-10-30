# Vendored review agents

The review skill fans out to these subagents. They are copied unchanged from [ECC](https://github.com/affaan-m/ECC) at commit `bf70150eb2df8070024e5bdf08e4aa08959e2735` (MIT, see [LICENSE-ECC](LICENSE-ECC)), the same definitions the team uses locally.

At run time `poster/src/agents.ts` turns them into the `--agents` JSON for `claude -p`. It keeps each prompt as written, prepends a short note about the read-only environment (no shell, everything pre-fetched into `context/`), and overrides the frontmatter: tools become `Read, Grep, Glob`, and the model is inherited from the main session.

To update: copy the new files over these, record the ECC commit here, and check the diff in review. These prompts steer what the bot reports, so changes to them are changes to the review bar.
