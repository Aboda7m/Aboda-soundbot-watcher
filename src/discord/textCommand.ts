/** Pure parsing/matching for the text command. No discord.js here, so it is trivially testable. */

export type SoundCommand = { kind: "sound"; name: string } | { kind: "usage" };
export type ImportCommand =
  | { kind: "import"; url: string; startSec?: number; endSec?: number }
  | { kind: "import-usage" };
export type EntranceCommand =
  | { kind: "entrance-show" }
  | { kind: "entrance-set"; name: string }
  | { kind: "entrance-clear" }
  | { kind: "entrance-mention" };
export type ParsedCommand = SoundCommand | ImportCommand;

const QUOTES = /^["“”„'‘’]+|["“”„'‘’]+$/g;

/**
 * Parses time strings like "10", "1:30", "01:20" into total seconds.
 */
function parseTime(str: string): number | null {
  if (/^\d+(\.\d+)?$/.test(str)) {
    return Number(str);
  }
  const parts = str.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[0]!) && /^\d+(\.\d+)?$/.test(parts[1]!)) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  if (parts.length === 3 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!) && /^\d+(\.\d+)?$/.test(parts[2]!)) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  return null;
}

/**
 * Accepts:  !import <URL> [from X to Y]
 */
export function parseImportCommand(content: string, prefix = "!", command = "import"): ImportCommand | null {
  const text = content.trim();
  const head = `${prefix}${command}`;
  if (!text.toLowerCase().startsWith(head.toLowerCase())) return null;
  const rest = text.slice(head.length);
  if (rest !== "" && !/^\s/.test(rest)) return null;

  const trimmedRest = rest.trim();
  if (!trimmedRest) return { kind: "import-usage" };

  // Match pattern like: <URL> from <start> to <end>  or just <URL>
  const match = /^([^\s]+)(?:\s+from\s+([^\s]+)\s+to\s+([^\s]+))?$/i.exec(trimmedRest);
  if (!match || !match[1]) {
    return { kind: "import-usage" };
  }

  const url = match[1];
  let startSec: number | undefined;
  let endSec: number | undefined;

  if (match[2] && match[3]) {
    const s = parseTime(match[2]);
    const e = parseTime(match[3]);
    if (s !== null && e !== null && s < e) {
      startSec = s;
      endSec = e;
    }
  }

  return { kind: "import", url, startSec, endSec };
}

/**
 * Accepts:  !sound "air horn"   !sound air horn   !sound “air horn”
 * Returns null when the message is not this command at all (e.g. "!soundcheck", "hello").
 */
export function parseSoundCommand(content: string, prefix = "!", command = "sound"): SoundCommand | null {
  const text = content.trim();
  const head = `${prefix}${command}`;
  if (!text.toLowerCase().startsWith(head.toLowerCase())) return null;
  const rest = text.slice(head.length);
  if (rest !== "" && !/^\s/.test(rest)) return null; // "!soundcheck" is not "!sound check"
  const name = rest.trim().replace(QUOTES, "").trim();
  return name ? { kind: "sound", name } : { kind: "usage" };
}

/** Exact match first, then case-insensitive. Returns the real library name or null. */
export function matchSoundName(input: string, names: string[]): string | null {
  if (names.includes(input)) return input;
  const lower = input.toLowerCase();
  return names.find((n) => n.toLowerCase() === lower) ?? null;
}

/** Discord's hard limit is 2000 characters; stay well below it. */
export const MAX_MESSAGE_CHARS = 1900;

/** Escapes Discord markdown so sound names display literally. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_`~|>])/g, "\\$1");
}

/** Returns the argument text after `<prefix><command>`, or null when the message is not that command. */
function commandRest(content: string, prefix: string, command: string): string | null {
  const text = content.trim();
  const head = `${prefix}${command}`;
  if (!text.toLowerCase().startsWith(head.toLowerCase())) return null;
  const rest = text.slice(head.length);
  if (rest !== "" && !/^\s/.test(rest)) return null;
  return rest.trim();
}

/** `!soundlist` (arguments are ignored). `!soundlistx` is not this command. */
export function parseSoundListCommand(content: string, prefix = "!"): { kind: "soundlist" } | null {
  return commandRest(content, prefix, "soundlist") === null ? null : { kind: "soundlist" };
}

/**
 * `!entrance`, `!entrance <name>`, `!entrance !clear`, `!RM-entrance` (clear alias).
 * A Discord mention as the argument is reported separately so the handler can refuse it
 * (entrance sounds can only be configured for yourself).
 */
export function parseEntranceCommand(content: string, prefix = "!"): EntranceCommand | null {
  if (commandRest(content, prefix, "rm-entrance") !== null) return { kind: "entrance-clear" };
  const rest = commandRest(content, prefix, "entrance");
  if (rest === null) return null;
  if (rest === "") return { kind: "entrance-show" };
  if (rest.toLowerCase() === `${prefix}clear`.toLowerCase()) return { kind: "entrance-clear" };
  if (/^<@[!&]?\d+>$/.test(rest) || /^@(everyone|here)$/i.test(rest)) return { kind: "entrance-mention" };
  const name = rest.replace(QUOTES, "").trim();
  return name ? { kind: "entrance-set", name } : { kind: "entrance-show" };
}

export type SoundResolution =
  | { kind: "match"; name: string }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "none" };

/**
 * Priority: 1) exact name  2) case-insensitive exact name  3) unique case-insensitive substring.
 * Never picks arbitrarily: several equally good candidates are returned as "ambiguous".
 * Pass `allowPartial: false` to stop after step 2 (partial matches then come back as `suggestions`
 * via {@link partialMatches}).
 */
export function resolveSoundName(input: string, names: string[], opts: { allowPartial?: boolean } = {}): SoundResolution {
  if (names.includes(input)) return { kind: "match", name: input };
  const lower = input.toLowerCase();
  const ci = names.filter((n) => n.toLowerCase() === lower);
  if (ci.length === 1) return { kind: "match", name: ci[0]! };
  if (ci.length > 1) return { kind: "ambiguous", matches: ci };
  if (opts.allowPartial === false || !lower) return { kind: "none" };
  const part = partialMatches(input, names);
  if (part.length === 1) return { kind: "match", name: part[0]! };
  if (part.length > 1) return { kind: "ambiguous", matches: part };
  return { kind: "none" };
}

/** Case-insensitive substring matches against canonical names, in the order given. */
export function partialMatches(input: string, names: string[]): string[] {
  const lower = input.toLowerCase();
  if (!lower) return [];
  return names.filter((n) => n.toLowerCase().includes(lower));
}

/**
 * Packs lines into messages of at most `max` characters, never splitting a line unless a single
 * line is itself longer than `max` (then it is hard-split). `header` is prepended to the first chunk.
 */
export function chunkLines(lines: string[], max = MAX_MESSAGE_CHARS, header = ""): string[] {
  const out: string[] = [];
  let cur = header.replace(/\n+$/, ""); // header is treated as the first line
  const push = () => {
    if (cur.trim() !== "") out.push(cur);
    cur = "";
  };
  for (const raw of lines) {
    for (let i = 0; i === 0 || i < raw.length; i += max) {
      const line = raw.slice(i, i + max);
      const next = cur === "" ? line : `${cur}\n${line}`;
      if (next.length > max) {
        push();
        cur = line;
      } else cur = next;
    }
  }
  push();
  return out;
}
