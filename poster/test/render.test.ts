import assert from "node:assert/strict";
import { test } from "node:test";
import { closingReply, summaryBody, type Finding, type SummaryInput } from "../src/render.ts";

const finding = (id: string, level: Finding["level"], path: string): Finding => ({
  id,
  level,
  path,
  line: 10,
  title: `title of ${id}`,
  evidence: "evidence",
  fix: "fix",
  confidence: "high",
  needsRun: false,
});

// The tally once counted findings the body didn't name: an open earlier blocker plus a new blocker and
// new nits that appeared only as inline comments in the diff.
const input: SummaryInput = {
  verdict: "request_changes",
  notApprovedBecause: [],
  modelSummary: "summary",
  posted: [finding("B3", "blocker", "src/runtime/runtime.ts"), finding("F19", "follow-up", "src/runtime/runtime.ts"), finding("N8", "nit", "src/a.ts")],
  additional: [finding("N9", "nit", "native/src/b.rs")],
  nitsOverCap: 0,
  prior: [
    { id: "B2", level: "blocker", title: "title of B2", path: "src/runtime/runtime.ts", line: 1075, status: "open", evidence: "still there" },
    { id: "F5", level: "follow-up", title: "title of F5", path: "src/x.ts", line: 1, status: "fixed", evidence: "gone" },
  ],
  escalation: { needed: false, owners: [], paths: [], noCodeowners: false },
  escalationReason: "",
  admins: [],
  ci: { state: "pass", notes: "" },
  reviewMdSuggestions: [],
  headSha: "a5a0171b",
  scope: "full review",
  runUrl: "https://example.test/run",
  handle: "@example-reviewer",
  team: "@neralabs/reviewer",
  state: { v: 1, sha: "a5a0171b", findings: [] },
};

test("the body names every finding the tally counts, new blockers and nits included", () => {
  const body = summaryBody(input);
  assert.match(body, /2 blockers · 1 follow-up · 2 nits/);
  for (const id of ["B2", "B3", "F19", "N8", "N9"]) assert.match(body, new RegExp(`- ${id} title of ${id}`), `${id} missing from the body`);
  const blockers = body.slice(body.indexOf("**Blockers**"), body.indexOf("**Follow-ups**"));
  assert.match(blockers, /- B2 title of B2 \(`src\/runtime\/runtime.ts:1075`\)\. _Still open:_ still there/);
  assert.match(blockers, /- B3 title of B3 \(`src\/runtime\/runtime.ts:10`\)\. _New\._/);
  const resolved = body.slice(body.indexOf("Resolved since the last review"));
  assert.match(resolved, /\(1 fixed\)[\s\S]*- F5 \[follow-up\] title of F5\. _Fixed:_ gone/);
  assert.doesNotMatch(body, /\| Status \|/);
});

// Audit M2 (a): a path with a backtick closed the code span, pinged someone, loaded an image and opened a comment.
test("a path can't break out of the code it's shown in", () => {
  const path = "` @victim <img src=x> <!--";
  const body = summaryBody({
    ...input,
    posted: [finding("B3", "blocker", path)],
    additional: [finding("N9", "nit", path)],
    prior: [],
    escalation: { needed: true, owners: [], paths: [path], noCodeowners: false },
    escalationReason: "risky",
  });
  assert.match(body, /- B3 title of B3 \(`` ` @victim <img src=x> <!--:10 ``\)\. _New\._/);
  assert.match(body, /covers `` ` @victim <img src=x> <!-- ``\./);
  // <summary> is HTML, where Markdown code doesn't apply.
  assert.match(body, /<summary>N9 <code>` @victim &lt;img src=x&gt; &lt;!--:10<\/code><\/summary>/);
});

test("closing a thread as moot posts sanitized evidence", () => {
  const reply = closingReply({ status: "moot", evidence: "per @victim ![x](https://evil.example/p.png) <img src=x> -->" }, "a5a0171b");
  assert.equal(reply, "Marked moot: per @\u2060victim !\\[x](https://evil.example/p.png) &lt;img src=x> --&gt;");
  assert.equal(closingReply({ status: "fixed", evidence: "@victim" }, "a5a0171b"), "Fixed in `a5a0171`.");
});
