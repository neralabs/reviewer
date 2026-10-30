// What the bot has already said on a PR: its reviews (and the state marker in
// the latest summary) and its finding threads. GitHub is the only store.

import type { GitHub, RepoRef } from "./github.ts";
import { decodeState, findingIdFromBody, type ReviewState } from "./text.ts";

export interface Review {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string | null;
  commit_id: string;
  submitted_at?: string;
}

export function listReviews(gh: GitHub, repo: RepoRef, pr: number): Promise<Review[]> {
  return gh.paginate<Review>(`/repos/${repo.owner}/${repo.repo}/pulls/${pr}/reviews`);
}

/** State from the bot's most recent review that carries a marker. */
export function latestState(reviews: readonly Review[], botLogin: string): ReviewState | undefined {
  for (let i = reviews.length - 1; i >= 0; i--) {
    const review = reviews[i]!;
    if (review.user?.login !== botLogin) continue;
    const state = decodeState(review.body);
    if (state) return state;
  }
  return undefined;
}

/** The bot's approvals that still count: GitHub keeps one decision per reviewer, the latest non-comment review. */
export function activeBotApprovals(reviews: readonly Review[], botLogin: string): Review[] {
  const decisive = reviews.filter((r) => r.user?.login === botLogin && r.state !== "COMMENTED" && r.state !== "PENDING");
  const last = decisive.at(-1);
  return last?.state === "APPROVED" ? [last] : [];
}

export interface ThreadComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface FindingThread {
  threadId: string;
  findingId: string;
  isResolved: boolean;
  url: string;
  /** Replies after the bot's opening comment. */
  replies: ThreadComment[];
}

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 50) {
            nodes { author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          comments: { nodes: { author: { login: string } | null; body: string; createdAt: string; url: string }[] };
        }[];
      };
    };
  };
}

/** GraphQL reports an app as "neralabs-reviewer" where REST says "neralabs-reviewer[bot]". */
function sameActor(graphqlLogin: string | undefined, restLogin: string): boolean {
  return graphqlLogin === restLogin || `${graphqlLogin}[bot]` === restLogin;
}

export async function findingThreads(gh: GitHub, repo: RepoRef, pr: number, botLogin: string): Promise<FindingThread[]> {
  const threads: FindingThread[] = [];
  let after: string | null = null;
  do {
    const page: ThreadsPage = await gh.graphql<ThreadsPage>(THREADS_QUERY, { owner: repo.owner, name: repo.repo, number: pr, after });
    const { nodes, pageInfo } = page.repository.pullRequest.reviewThreads;
    for (const node of nodes) {
      const [first, ...rest] = node.comments.nodes;
      if (!first || !sameActor(first.author?.login, botLogin)) continue;
      const findingId = findingIdFromBody(first.body);
      if (!findingId) continue;
      threads.push({
        threadId: node.id,
        findingId,
        isResolved: node.isResolved,
        url: first.url,
        replies: rest.map((c) => ({ author: c.author?.login ?? "ghost", body: c.body, createdAt: c.createdAt })),
      });
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
  return threads;
}
