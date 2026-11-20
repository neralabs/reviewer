import assert from "node:assert/strict";
import { test } from "node:test";
import { botChangeRequests, type Review } from "../src/bot-history.ts";
import { GitHub, GitHubError } from "../src/github.ts";
import { dismissChangeRequests } from "../src/respond.ts";

const BOT = "neralabs-reviewer[bot]";
const REPO = { owner: "neralabs", repo: "rerail" };
const CLEAN = "8802bda7f00dcafe";

const review = (id: number, login: string, state: string, commit: string): Review => ({ id, user: { login }, state, body: null, commit_id: commit });

// The shape of rerail#869: three bot change requests, comments from the bot and a person, a person's own change request.
const HISTORY: Review[] = [
  review(1, BOT, "CHANGES_REQUESTED", "4d447563aa"),
  review(2, BOT, "CHANGES_REQUESTED", "ef97dd25aa"),
  review(3, BOT, "COMMENTED", "ef97dd25aa"),
  review(4, "Moti-Velz", "CHANGES_REQUESTED", "7afaa915aa"),
  review(5, BOT, "CHANGES_REQUESTED", "7afaa915aa"),
  review(6, "Moti-Velz", "COMMENTED", "7afaa915aa"),
  review(7, BOT, "DISMISSED", "12b82bb6aa"),
  review(8, BOT, "COMMENTED", CLEAN),
];

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A GitHub client whose requests are recorded; `fail` makes the dismissal of those review ids throw. */
function fakeGitHub(fail: readonly number[] = []): { gh: GitHub; calls: Call[] } {
  const calls: Call[] = [];
  const gh = new GitHub("token");
  gh.request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    const id = Number(/reviews\/(\d+)\/dismissals$/.exec(path)?.[1]);
    if (fail.includes(id)) throw new GitHubError(method, path, 403, "Resource not accessible by integration");
    return undefined as T;
  };
  return { gh, calls };
}

const dismissedIds = (calls: readonly Call[]) => calls.map((c) => Number(/reviews\/(\d+)\/dismissals$/.exec(c.path)?.[1]));

test("botChangeRequests picks the bot's undismissed change requests and nothing of a person's", () => {
  assert.deepEqual(botChangeRequests(HISTORY, BOT).map((r) => r.id), [1, 2, 5]);
});

test("a clean comment dismisses every earlier change request of the bot, naming the clean commit", async () => {
  const { gh, calls } = fakeGitHub();
  const problems = await dismissChangeRequests(gh, REPO, 869, HISTORY, BOT, { verdict: "comment", sha: CLEAN });
  assert.deepEqual(problems, []);
  assert.deepEqual(dismissedIds(calls), [1, 2, 5]);
  for (const c of calls) {
    assert.equal(c.method, "PUT");
    assert.match(c.path, /^\/repos\/neralabs\/rerail\/pulls\/869\/reviews\/\d+\/dismissals$/);
    assert.deepEqual(c.body, { message: "Superseded by a review with no blockers at 8802bda.", event: "DISMISS" });
  }
});

test("a clean approval dismisses them too", async () => {
  const { gh, calls } = fakeGitHub();
  await dismissChangeRequests(gh, REPO, 869, HISTORY, BOT, { verdict: "approve", sha: CLEAN });
  assert.deepEqual(dismissedIds(calls), [1, 2, 5]);
});

test("a person's change request is left alone", async () => {
  const { gh, calls } = fakeGitHub();
  await dismissChangeRequests(gh, REPO, 869, HISTORY, BOT, { verdict: "comment", sha: CLEAN });
  assert.ok(!dismissedIds(calls).includes(4));
});

test("a review that still has blockers dismisses nothing", async () => {
  const { gh, calls } = fakeGitHub();
  const problems = await dismissChangeRequests(gh, REPO, 869, HISTORY, BOT, { verdict: "request_changes", sha: CLEAN });
  assert.deepEqual(problems, []);
  assert.deepEqual(calls, []);
});

test("with nothing to dismiss, it makes no request", async () => {
  const { gh, calls } = fakeGitHub();
  const settled = HISTORY.map((r) => (r.user?.login === BOT && r.state === "CHANGES_REQUESTED" ? { ...r, state: "DISMISSED" } : r));
  assert.deepEqual(await dismissChangeRequests(gh, REPO, 869, settled, BOT, { verdict: "comment", sha: CLEAN }), []);
  assert.deepEqual(await dismissChangeRequests(gh, REPO, 869, [], BOT, { verdict: "comment", sha: CLEAN }), []);
  assert.deepEqual(calls, []);
});

test("a failed dismissal is reported as a problem and the rest still go through", async () => {
  const { gh, calls } = fakeGitHub([2]);
  const problems = await dismissChangeRequests(gh, REPO, 869, HISTORY, BOT, { verdict: "comment", sha: CLEAN });
  assert.deepEqual(dismissedIds(calls), [1, 2, 5]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^couldn't dismiss the change request at ef97dd2: PUT .* -> 403/);
});
