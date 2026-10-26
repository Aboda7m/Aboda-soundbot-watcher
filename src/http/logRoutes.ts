import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";

/** Where the two JSON logs live. A missing file just means nothing has been logged yet. */
export interface LogFiles {
  soundPlayFile: string;
  voiceActivityFile: string;
}

/** What the log routes borrow from server.ts so they share its headers and JSON helper. */
export interface LogRouteKit {
  json(res: ServerResponse, status: number, body: unknown): void;
  /** When supplied, only entries with a guildId in this list are visible. */
  allowedGuildIds?: readonly string[];
}

type LogType = "sound" | "voice";
type LogEntry = Record<string, string | null>;

/**
 * Only these fields are sent to the browser. To show a new field, add its name here
 * and add a column for it in public/logs.js.
 */
const FIELDS: Record<LogType, readonly string[]> = {
  sound: ["timestamp", "sound", "guildId", "channelId", "source", "trigger", "userId", "username"],
  voice: ["timestamp", "action", "userId", "guildId", "username", "guildName", "channelName", "previousChannelName"],
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FIELD_CHARS = 300;

interface Parsed {
  entries: LogEntry[];
  /** Entries that could not be read and were left out. */
  skipped: number;
}

// Re-parsing a big file on every poll would be wasteful: reuse the result until the file changes.
const cache = new Map<string, { mtimeMs: number; size: number; parsed: Parsed }>();

function normalize(type: LogType, raw: unknown): LogEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const out: LogEntry = {};
  for (const field of FIELDS[type]) {
    const v = rec[field];
    out[field] =
      typeof v === "string"
        ? v.slice(0, MAX_FIELD_CHARS)
        : typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : null;
  }
  return out;
}

function parseLog(type: LogType, text: string): Parsed {
  let raw: unknown[] | null = null;
  let skipped = 0;

  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v)) raw = v;
  } catch {
    // Handled below.
  }

  if (!raw) {
    // Damaged or half-written file: salvage every flat {...} object that is still readable.
    raw = [];
    for (const m of text.matchAll(/\{[^{}]*\}/g)) {
      try {
        raw.push(JSON.parse(m[0]));
      } catch {
        skipped++;
      }
    }
  }

  const entries: LogEntry[] = [];
  for (const r of raw) {
    const e = normalize(type, r);
    if (e) entries.push(e);
    else skipped++;
  }
  return { entries, skipped };
}

class TooLarge extends Error {}

async function load(type: LogType, file: string): Promise<Parsed> {
  const cacheKey = `${type}:${file}`;
  let info;
  try {
    info = await stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache.delete(cacheKey);
      return { entries: [], skipped: 0 };
    }
    throw err;
  }

  if (info.size > MAX_FILE_BYTES) throw new TooLarge();

  const hit = cache.get(cacheKey);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.parsed;

  const parsed = parseLog(type, await readFile(file, "utf8"));
  cache.set(cacheKey, { mtimeMs: info.mtimeMs, size: info.size, parsed });
  return parsed;
}

/**
 * GET /api/logs?type=sound|voice
 *   (no range)         the newest `limit` entries
 *   &before=N          up to `limit` entries that come before index N (older entries)
 *   &from=N            up to `limit` entries starting at index N (new entries since the last load)
 *   &limit=N           1..5000, default 200
 * Entries are always returned oldest first; `start` is the index of the first one and `total` the
 * number of entries in the file, so the page can tell what it is still missing.
 *
 * Returns true if the request was one of ours (and has been answered).
 */
export async function handleLogRoute(
  logs: LogFiles,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kit: LogRouteKit,
): Promise<boolean> {
  if (req.method !== "GET" || url.pathname !== "/api/logs") return false;

  const type = url.searchParams.get("type");
  if (type !== "sound" && type !== "voice") {
    kit.json(res, 400, { error: "type must be sound or voice" });
    return true;
  }

  const int = (name: string): number | null => {
    const v = url.searchParams.get(name);
    if (v === null) return null;
    return /^\d{1,9}$/.test(v) ? Number(v) : Number.NaN;
  };

  const limit = int("limit") ?? DEFAULT_LIMIT;
  const before = int("before");
  const from = int("from");

  if (
    Number.isNaN(limit) ||
    Number.isNaN(before) ||
    Number.isNaN(from) ||
    limit < 1 ||
    limit > MAX_LIMIT ||
    (before !== null && from !== null)
  ) {
    kit.json(res, 400, {
      error: `limit must be 1-${MAX_LIMIT}; before and from must be whole numbers and cannot be combined`,
    });
    return true;
  }

  try {
    const file = type === "sound" ? logs.soundPlayFile : logs.voiceActivityFile;
    const loaded = await load(type, file);
    const entries = kit.allowedGuildIds
      ? loaded.entries.filter((entry) => typeof entry.guildId === "string" && kit.allowedGuildIds!.includes(entry.guildId))
      : loaded.entries;
    const skipped = loaded.skipped;
    const total = entries.length;

    let start: number;
    let end: number;
    if (from !== null) {
      start = Math.min(from, total);
      end = Math.min(total, start + limit);
    } else {
      end = Math.min(before ?? total, total);
      start = Math.max(0, end - limit);
    }

    kit.json(res, 200, { type, total, start, skipped, entries: entries.slice(start, end) });
  } catch (err) {
    if (err instanceof TooLarge) {
      kit.json(res, 413, { error: "Log file is too large to display." });
    } else {
      console.error("Log read error:", err);
      kit.json(res, 500, { error: "Could not read the log file." });
    }
  }
  return true;
}
