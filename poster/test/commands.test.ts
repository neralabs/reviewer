import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/commands.ts";

const H = "@example-reviewer";

test("each command parses", () => {
  assert.deepEqual(parseCommand(`${H} review`, H), { kind: "review", full: false });
  assert.deepEqual(parseCommand(`${H} review full`, H), { kind: "review", full: true });
  assert.deepEqual(parseCommand(`${H} stop`, H), { kind: "stop" });
  assert.deepEqual(parseCommand(`${H} help`, H), { kind: "help" });
  assert.deepEqual(parseCommand(`@Example-Reviewer Review`, H), { kind: "review", full: false });
});

test("rereview keeps the whole feedback, across lines", () => {
  assert.deepEqual(parseCommand(`${H} rereview B1 is intentional:\nthe cache is per-request.`, H), {
    kind: "rereview",
    feedback: "B1 is intentional:\nthe cache is per-request.",
  });
});

test("a mention inside a sentence still counts", () => {
  assert.equal(parseCommand(`Thanks! ${H} review always please`, H)?.kind, "review");
});

test("quoted or fenced commands don't fire again", () => {
  assert.equal(parseCommand(`> ${H} review\n\nAgreed with the above.`, H), undefined);
  assert.equal(parseCommand("```\n@example-reviewer review\n```", H), undefined);
});

test("similar handles and email-like text are not mentions", () => {
  assert.equal(parseCommand("@example-reviewer-staging review", H), undefined);
  assert.equal(parseCommand("ping me@example-reviewer review", H), undefined);
  assert.equal(parseCommand("no mention here", H), undefined);
});

test("an unknown word gets help at top level, but is feedback in a finding thread", () => {
  assert.deepEqual(parseCommand(`${H} approve this`, H), { kind: "help", unknown: "approve this" });
  assert.deepEqual(parseCommand(`${H} this is intentional, see the ADR`, H, true), { kind: "rereview", feedback: "this is intentional, see the ADR" });
  assert.deepEqual(parseCommand(`${H} stop`, H, true), { kind: "stop" });
});
