// Minimal GitHub REST/GraphQL client on fetch. Two instances run side by side
// in the poster job: one with the caller's read-only GITHUB_TOKEN, one with
// the neralabs-reviewer token for writes.

export class GitHubError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepo(fullName: string): RepoRef {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`bad repository name: ${fullName}`);
  return { owner, repo };
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class GitHub {
  private readonly token: string;
  private readonly apiUrl: string;

  constructor(token: string, apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com") {
    if (!token) throw new Error("GitHub token is empty");
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  private async send(method: Method, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    const url = path.startsWith("https://") ? path : `${this.apiUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "neralabs-reviewer",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new GitHubError(method, path, res.status, await res.text());
    return res;
  }

  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async text(path: string, accept = "application/vnd.github.raw+json"): Promise<string> {
    const res = await this.send("GET", path, undefined, accept);
    return res.text();
  }

  /**
   * Follows Link: rel="next". `pick` extracts the array from wrapped responses (e.g. check-runs).
   * Like get<T>, the page type is the caller's statement of GitHub's documented response shape.
   */
  async paginate<T, P = T[]>(path: string, pick?: (page: P) => T[]): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next) {
      const res = await this.send("GET", next);
      const page = (await res.json()) as P;
      items.push(...(pick ? pick(page) : (page as T[])));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    }
    return items;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request<{ data?: T; errors?: unknown[] }>("POST", "/graphql", { query, variables });
    if (res.errors?.length || !res.data) throw new Error(`GraphQL error: ${JSON.stringify(res.errors)}`);
    return res.data;
  }
}

/** Contents of a file at a ref, or undefined when it doesn't exist. */
export async function fileAt(gh: GitHub, repo: RepoRef, path: string, ref: string): Promise<string | undefined> {
  try {
    return await gh.text(`/repos/${repo.owner}/${repo.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return undefined;
    throw err;
  }
}
