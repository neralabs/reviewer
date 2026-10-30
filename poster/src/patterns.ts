// CODEOWNERS path patterns, as GitHub documents them. Used for CODEOWNERS
// itself and for the path lists in REVIEW.md (high-risk, generated), so a
// repo writes every path list one way.
//
// - A leading "/" or a "/" in the middle anchors the pattern to the repo root;
//   otherwise it matches at any depth.
// - A trailing "/" matches everything under that directory.
// - "*" and "?" don't cross "/"; "**" does.
// - A pattern whose last segment is literal also matches everything under it
//   (`docs` matches docs/a.md). One whose last segment has a wildcard matches
//   only at that depth (`docs/*` matches docs/a.md, not docs/x/a.md).

const regexCache = new Map<string, RegExp>();

function translate(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      out += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

export function patternToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  let body = pattern.trim();
  const dirOnly = body.endsWith("/");
  if (dirOnly) body = body.replace(/\/+$/, "");
  const anchored = body.startsWith("/") || body.includes("/");
  body = body.replace(/^\/+/, "");

  const lastSegment = body.slice(body.lastIndexOf("/") + 1);
  const suffix = dirOnly ? "/.*$" : /[*?]/.test(lastSegment) && lastSegment !== "**" ? "$" : "(?:/.*)?$";
  const regex = new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${translate(body)}${suffix}`);
  regexCache.set(pattern, regex);
  return regex;
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => patternToRegExp(p).test(path));
}

export interface OwnerRule {
  pattern: string;
  owners: string[];
}

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern) rules.push({ pattern, owners: owners.filter((o) => o.startsWith("@")) });
  }
  return rules;
}

/** Owners of one path: the last matching rule wins, and a rule with no owners unowns the path. */
export function ownersOf(path: string, rules: readonly OwnerRule[]): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (patternToRegExp(rule.pattern).test(path)) return rule.owners;
  }
  return [];
}
