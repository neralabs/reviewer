export type Command =
  | { kind: "review"; full: boolean }
  | { kind: "rereview"; feedback: string }
  | { kind: "stop" }
  | { kind: "help"; unknown?: string };

export const HELP_TEXT = (handle: string, team: string, largePrLines: number): string =>
  [
    `| Command | Effect |`,
    `|---|---|`,
    `| \`${handle} review\` | Review the current head. If I reviewed this PR before, I review only what changed since (or re-check my findings when nothing changed) |`,
    `| \`${handle} review full\` | A fresh full review of the whole PR, even over ${largePrLines.toLocaleString("en-US")} changed lines |`,
    `| \`${handle} rereview <feedback>\` | Re-review the current head, using your feedback |`,
    `| \`${handle} stop\` | Withdraw my approval and cancel any review in progress |`,
    `| \`${handle} help\` | This list |`,
    ``,
    `I review only when asked: a command above, or requesting ${team} in Reviewers. I clear that request after each review, so request it again for another one. Pushes do nothing: they don't start a review, and my approval stays, like a human's. Commands addressed to ${team} work too. You can also reply to one of my findings mentioning \`${handle}\` ("intentional", "won't fix: <reason>", "wrong, because ..."). Only people with write access can trigger me.`,
  ].join("\n");

/** Comment text a human wrote: fenced code and quoted lines removed, so a quoted command doesn't fire again. */
function authoredText(body: string): string {
  return body
    .replace(/^```[\s\S]*?^```[ \t]*$/gm, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/** The text after the first mention of the handle, or undefined if there is no mention. */
export function afterMention(body: string, handle: string): string | undefined {
  const text = authoredText(body);
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[^\\w/-])${escaped}(?![\\w-])`, "i").exec(text);
  return match ? text.slice(match.index + match[0].length).trim() : undefined;
}

/**
 * Parses a command. In a reply on one of the bot's finding threads, text that
 * isn't a command is feedback; elsewhere it gets the help text.
 */
export function parseCommand(body: string, handle: string, inBotThread = false): Command | undefined {
  const rest = afterMention(body, handle);
  if (rest === undefined) return undefined;
  const [word = "", ...tail] = rest.split(/\s+/);
  const verb = word.toLowerCase().replace(/[.,:;!]+$/, "");
  const firstLineArgs = rest.split("\n")[0]!.split(/\s+/).slice(1).map((a) => a.toLowerCase());

  switch (verb) {
    case "review":
      return { kind: "review", full: firstLineArgs.includes("full") };
    case "rereview":
    case "re-review":
      return { kind: "rereview", feedback: rest.slice(word.length).trim() };
    case "re": {
      // "re review, that is not a blocker"
      const next = /^re\s+review\b[.,:;!]*/i.exec(rest);
      if (next) return { kind: "rereview", feedback: rest.slice(next[0].length).trim() };
      break;
    }
    case "stop":
      return { kind: "stop" };
    case "help":
      return { kind: "help" };
  }
  if (inBotThread) return { kind: "rereview", feedback: rest };
  return { kind: "help", unknown: [word, ...tail].join(" ").slice(0, 80) };
}
