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

// ───────────────────────── !sound search: normalization + fuzzy matching ─────────────────────────

/**
 * Confidence thresholds for `!sound`. A sound is played automatically only when a tier below says
 * it is reliable; everything else becomes a suggestion list. All scores are on comparison keys
 * (lowercase letters/digits only), never on the canonical names.
 */
export const SEARCH_THRESHOLDS = {
  /** A unique substring auto-plays only when the query key has at least this many characters. */
  minSubstringLen: 3,
  /** A fuzzy (typo) match auto-plays at or above this similarity (1 - editDistance / longerLength)... */
  fuzzyPlay: 0.88,
  /** ...when it beats the runner-up by at least this much... */
  fuzzyGap: 0.12,
  /** ...and both the query and the sound key are at least this long (short names are too easy to confuse). */
  fuzzyMinLen: 5,
  /** Candidates at or above this similarity are offered as suggestions. */
  fuzzySuggest: 0.6,
  maxSuggestions: 5,
} as const;

export type SoundSearch =
  | { kind: "match"; name: string; via: "exact" | "normalized" | "reordered" | "partial" | "fuzzy" }
  | { kind: "ambiguous"; matches: string[] } // several equally valid candidates: ask the user to be specific
  | { kind: "suggest"; matches: string[] } // nothing reliable enough to play, but these are close
  | { kind: "none" };

const SEPARATORS = /[^\p{L}\p{N}]+/u;
const MARKER = /^(?:[-–—*+>]+\s+|[•·▪●◦]+\s*|\d{1,3}[.)]\s+)/u;

/** Removes harmless formatting: list markers (`- `, `• `, `1. `), wrapping quotes, extra whitespace. */
export function normalizeSoundQuery(input: string): string {
  let s = input.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 5; i++) {
    const next = s.replace(MARKER, "").replace(QUOTES, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Comparison key: case-folded letters and digits only, so `Bandar-Fifa`, `bandar fifa`, `bandar_fifa` all agree. */
function soundKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Keys of every word order of a name (`bandar-fifa` -> bandarfifa, fifabandar). Names with >4 words keep their own order. */
function orderKeys(name: string): string[] {
  const words = name.normalize("NFKC").toLowerCase().split(SEPARATORS).filter(Boolean);
  if (words.length < 2 || words.length > 4) return [soundKey(name)];
  const out = new Set<string>();
  const walk = (rest: string[], acc: string) => {
    if (rest.length === 0) return void out.add(acc);
    rest.forEach((w, i) => walk([...rest.slice(0, i), ...rest.slice(i + 1)], acc + w));
  };
  walk(words, "");
  return [...out];
}

/** Optimal-string-alignment (Damerau–Levenshtein) distance: counts a swap of two neighbours as one edit. */
export function editDistance(a: string, b: string): number {
  const A = [...a].slice(0, 64);
  const B = [...b].slice(0, 64);
  const d: number[][] = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array<number>(B.length).fill(0)]);
  for (let j = 0; j <= B.length; j++) d[0]![j] = j;
  for (let i = 1; i <= A.length; i++)
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[A.length]![B.length]!;
}

/** 1 = identical, 0 = nothing in common. */
export function similarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : 1 - editDistance(a, b) / longer;
}

/**
 * Resolves `!sound <input>` against the real library names. Tiers, strongest first:
 *  1. exact name, then case-insensitive exact name (raw input, then with markers/quotes removed)
 *  2. same letters/digits ignoring case and separators        (`bandar fifa`, `bandarfifa`)
 *  3. same words in another order, spaced or run together     (`fifa bandar`, `fifabandar`)
 *  4. unique substring of a name, query of >= 3 characters    (`bandar-fif`)
 *  5. typo: highest similarity, only when clearly ahead (see SEARCH_THRESHOLDS)
 * Otherwise the result is "ambiguous" (several equally valid) or "suggest" (close but not reliable).
 * Input ending in a separator (`bandar-`) is treated as unfinished: it only ever suggests.
 * Canonical names are never altered, and a shorter/longer sibling (`bandar` vs `bandar-fifa`) is
 * never substituted unless it is the only candidate a tier allows.
 */
export function searchSound(input: string, names: string[], t: typeof SEARCH_THRESHOLDS = SEARCH_THRESHOLDS): SoundSearch {
  const raw = resolveSoundName(input, names, { allowPartial: false });
  if (raw.kind === "match") return { kind: "match", name: raw.name, via: "exact" };
  if (raw.kind === "ambiguous") return raw;

  const q = normalizeSoundQuery(input);
  if (q !== input) {
    const r = resolveSoundName(q, names, { allowPartial: false });
    if (r.kind === "match") return { kind: "match", name: r.name, via: "exact" };
    if (r.kind === "ambiguous") return r;
  }
  const qKey = soundKey(q);
  if (qKey.length < 2) return { kind: "none" };

  const keys = names.map((n) => ({ name: n, key: soundKey(n), orders: orderKeys(n) }));
  const incomplete = /[-_.]$/.test(q); // trailing separator = unfinished name

  if (!incomplete) {
    const pick = (hits: typeof keys, via: "normalized" | "reordered" | "partial"): SoundSearch | null =>
      hits.length === 1 ? { kind: "match", name: hits[0]!.name, via } : hits.length > 1 ? { kind: "ambiguous", matches: hits.map((h) => h.name) } : null;

    const hit =
      pick(keys.filter((k) => k.key === qKey), "normalized") ??
      pick(keys.filter((k) => k.orders.includes(qKey)), "reordered") ??
      (qKey.length >= t.minSubstringLen ? pick(keys.filter((k) => k.key.includes(qKey)), "partial") : null);
    if (hit) return hit;

    const scored = keys
      .map((k) => ({ ...k, sim: Math.max(...k.orders.map((o) => similarity(qKey, o))) }))
      .filter((k) => k.sim >= t.fuzzySuggest)
      .sort((a, b) => b.sim - a.sim);
    const [best, second] = scored;
    if (
      best &&
      best.sim >= t.fuzzyPlay &&
      qKey.length >= t.fuzzyMinLen &&
      best.key.length >= t.fuzzyMinLen &&
      (!second || best.sim - second.sim >= t.fuzzyGap)
    )
      return { kind: "match", name: best.name, via: "fuzzy" };
  }

  // Suggestions: names that start with the query, then ones that contain it, then close spellings.
  const ranked = keys
    .map((k) => {
      if (k.key.startsWith(qKey)) return { name: k.name, rank: 0, score: 1 };
      if (k.key.includes(qKey)) return { name: k.name, rank: 1, score: 1 };
      if (incomplete) return null;
      return { name: k.name, rank: 2, score: Math.max(...k.orders.map((o) => similarity(qKey, o))) };
    })
    .filter((r): r is { name: string; rank: number; score: number } => r !== null && (r.rank < 2 || r.score >= t.fuzzySuggest))
    .sort((a, b) => a.rank - b.rank || b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, t.maxSuggestions)
    .map((r) => r.name);
  return ranked.length ? { kind: "suggest", matches: ranked } : { kind: "none" };
}
