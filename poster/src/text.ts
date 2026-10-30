// Everything the model writes is untrusted: it read the PR, and the PR can
// carry prompt injection. Before any of it reaches GitHub it is sanitized so
// that it can't ping people, forge the bot's state marker, make GitHub fetch
// an attacker's URL (images), or leak a credential.

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // The review job's one secret, AWS_BEARER_TOKEN_BEDROCK: a Bedrock API key, long-term (ABSK…) or short-term.
  // No leading \b on these: in transcript.jsonl a value often follows an escape, as in "\nABSK…" or, for a
  // dumped /proc/self/environ, "\u0000ABSK…", where the letter or digit before it hides the word boundary.
  /ABSK[A-Za-z0-9+/=]{20,}/g,
  /bedrock-api-key-[A-Za-z0-9+/=_-]{20,}/g,
  /(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,
  // Only the value after aws_secret_access_key (env, ini or JSON, raw or JSON-escaped), so the text still says what was there.
  /(?<=aws_secret_access_key\\?["']?\s*[:=]\s*\\?["']?)[A-Za-z0-9+/=]{20,}/gi,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, "[redacted]"), text);
}

/** A line that opens a fenced block (CommonMark: up to 3 spaces, then ``` with no backtick in the info string, or ~~~). */
const FENCE_OPEN = /^( {0,3})(`{3,}(?!.*`)|~{3,})/;
/** Any line that looks like a fence, including inside a list item or quote, or indented as code. */
const FENCE_LIKE = /^[\s>*+\-\d.)]*(`{3,}|~{3,})/;

/**
 * Which lines belong to a fenced block, whose content is left byte-for-byte.
 * This errs towards prose wherever GitHub could see the block differently: a
 * fence-like line inside a list item or quote, or indented, turns fences off
 * for the whole text; a fence must be closed; and a line indented less than
 * the opener (which would end a list item the fence sits in) disqualifies it.
 * Any indentation closes, which only ever ends a block early. Over-escaping
 * code is harmless; reading prose as code would let it through raw.
 */
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced = lines.map(() => false);
  if (lines.some((l) => FENCE_LIKE.test(l) && !FENCE_OPEN.test(l))) return fenced;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]!);
    if (!open) continue;
    const [, indent, marker] = open as unknown as [string, string, string];
    const close = new RegExp(`^[ \\t]*\\${marker[0]}{${marker.length},}[ \\t]*$`);
    for (let j = i + 1; j < lines.length; j++) {
      if (close.test(lines[j]!)) {
        fenced.fill(true, i, j + 1);
        i = j;
        break;
      }
      if (lines[j]!.trim() && /^[ \t]*/.exec(lines[j]!)![0].length < indent.length) break;
    }
  }
  return fenced;
}

/**
 * Splits one prose block into [prose, code, prose, code, …], finding inline
 * code spans the way CommonMark does: a backtick run not escaped by a
 * backslash opens a span that the next run of the same length closes. Only
 * spans on one line and without a `|` count as code (a GFM table splits cells
 * on `|` even inside code); the rest stays prose, where every backtick gets
 * escaped. So GitHub can't pair backticks differently from this split.
 */
function splitInlineCode(text: string): string[] {
  const parts: string[] = [];
  const runs = [...text.matchAll(/`+/g)];
  let last = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    let start = run.index;
    let length = run[0].length;
    if (/\\*$/.exec(text.slice(last, start))![0].length % 2 === 1) {
      start++;
      length--;
      if (!length) continue;
    }
    const close = runs.findIndex((r, j) => j > i && r[0].length === length);
    if (close < 0) continue;
    const end = runs[close]!.index + length;
    if (/[\n|]/.test(text.slice(start + length, end - length))) continue;
    parts.push(text.slice(last, start), text.slice(start, end));
    last = end;
    i = close;
  }
  parts.push(text.slice(last));
  return parts;
}

/** Rewrites prose outside code spans and fences; code is left byte-for-byte. */
function outsideCode(text: string, rewrite: (prose: string) => string): string {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const out: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(splitInlineCode(prose.join("\n")).map((part, i) => (i % 2 === 1 ? part : rewrite(part))).join(""));
    prose = [];
  };
  lines.forEach((line, i) => {
    if (!fenced[i]) return void prose.push(line);
    flush();
    out.push(line);
  });
  flush();
  return out.join("\n");
}

export function sanitizeModelText(text: string): string {
  // CommonMark also ends lines at a lone \r; one kind of line ending keeps the split above in step with GitHub.
  const safe = outsideCode(text.replace(/\r\n?/g, "\n"), (prose) =>
    prose
      // @user and @org/team would notify; a zero-width joiner keeps the text readable without linking.
      .replace(/(^|\W)@(?=[A-Za-z0-9])/g, "$1@\u2060")
      // Images make GitHub fetch a URL of the model's choosing. Escaping the bracket, not the "!", holds after a backslash too.
      .replace(/!\[/g, "!\\[")
      // Every "<", not only known tags: raw HTML parses before code spans, so a tag could
      // swallow a backtick and turn what looks like code here into live HTML there.
      .replace(/</g, "&lt;")
      // A backtick left in prose could pair with one elsewhere and shift every code span after it.
      .replace(/(\\*)`/g, (m, slashes: string) => (slashes.length % 2 === 1 ? m : `${slashes}&#96;`)),
  );
  // Comments anywhere could forge or hide a state marker.
  return redactSecrets(safe).replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}

/**
 * Markdown inline code showing text verbatim, whatever backticks it holds: the
 * delimiter is one backtick longer than the longest run inside. Line breaks
 * become spaces, since a span can't cross a block boundary.
 */
export function codeSpan(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ");
  const fence = "`".repeat(Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** An HTML <code> element, for places where Markdown isn't parsed (an HTML block such as <summary>). */
export function htmlCode(text: string): string {
  const escaped = text.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<code>${escaped}</code>`;
}

export interface StoredFinding {
  id: string;
  level: "blocker" | "follow-up" | "nit";
  path: string;
  line: number;
  title: string;
  status: "open" | "moot";
  /** Why it was ruled moot, from the feedback. */
  reason?: string;
}

export interface ReviewState {
  v: 1;
  /** Head SHA this review covered. */
  sha: string;
  findings: StoredFinding[];
}

const STATE_PREFIX = "<!-- reviewer:state ";
const STATE_RE = /<!-- reviewer:state (\{.*?\}) -->/g;

export function encodeState(state: ReviewState): string {
  // Escaping < and > keeps "-->" out of the comment while staying valid JSON.
  const json = JSON.stringify(state).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `${STATE_PREFIX}${json} -->`;
}

/** The last state marker in a review body. Model text is sanitized, so only the poster can write one. */
export function decodeState(body: string | null | undefined): ReviewState | undefined {
  if (!body) return undefined;
  const matches = [...body.matchAll(STATE_RE)];
  const json = matches.at(-1)?.[1];
  if (!json) return undefined;
  try {
    const state = JSON.parse(json) as ReviewState;
    return state.v === 1 && typeof state.sha === "string" && Array.isArray(state.findings) ? state : undefined;
  } catch {
    return undefined;
  }
}

export function findingMarker(id: string): string {
  return `<!-- reviewer:finding ${id} -->`;
}

export function findingIdFromBody(body: string | null | undefined): string | undefined {
  return body ? /<!-- reviewer:finding ([A-Za-z0-9-]+) -->/.exec(body)?.[1] : undefined;
}
