import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgents, SUBAGENT_TOOLS } from "../src/agents.ts";

const AGENTS_DIR = new URL("../../agents", import.meta.url).pathname;

test("every agent the skill names is vendored, parses, and runs read-only", () => {
  const agents = buildAgents(AGENTS_DIR);
  for (const name of ["code-reviewer", "typescript-reviewer", "rust-reviewer", "python-reviewer", "security-reviewer", "silent-failure-hunter"]) {
    const agent = agents[name];
    assert.ok(agent, `${name} is missing`);
    assert.deepEqual(agent.tools, SUBAGENT_TOOLS);
    assert.match(agent.prompt, /There is no shell/);
  }
});
