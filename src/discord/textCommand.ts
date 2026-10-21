/** Pure parsing/matching for the text command. No discord.js here, so it is trivially testable. */

export type ParsedCommand = { kind: "sound"; name: string } | { kind: "usage" };

const QUOTES = /^["“”„'‘’]+|["“”„'‘’]+$/g;

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
