/** Pure parsing/matching for the text command. No discord.js here, so it is trivially testable. */

export type ParsedCommand = 
  | { kind: "sound"; name: string } 
  | { kind: "import"; url: string; startSec?: number; endSec?: number }
  | { kind: "import-usage" }
  | { kind: "usage" };

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
export function parseImportCommand(content: string, prefix = "!", command = "import"): ParsedCommand | null {
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
export function parseSoundCommand(content: string, prefix = "!", command = "sound"): ParsedCommand | null {
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