import fs from "node:fs";
import path from "node:path";

const LOG_FILE_PATH = path.join(process.cwd(), "sound-play-logs.json");

export type SoundPlaySource = "manual" | "entrance" | "exit";
export type SoundPlayTrigger = "text-command" | "web" | "auto-entrance" | "auto-exit";

export interface SoundPlayLogRecord {
  timestamp: string;
  sound: string;
  guildId: string;
  channelId: string;
  source: SoundPlaySource;
  trigger: SoundPlayTrigger;
  userId: string | null;
  username: string | null;
}

export interface SoundPlayLogRequest {
  sound: string;
  guildId: string;
  channelId: string;
  source: SoundPlaySource;
  trigger: SoundPlayTrigger;
  requestedBy?: { userId: string; username?: string | null } | null;
}

/**
 * Reads the existing log. A read error (permissions, a directory in the way, ...) propagates, so a file
 * that could not be read is never overwritten. A file that was read but is not a JSON array (damaged or
 * half-written) is moved aside for recovery instead of being replaced.
 */
function readExisting(): SoundPlayLogRecord[] {
  if (!fs.existsSync(LOG_FILE_PATH)) return [];

  const text = fs.readFileSync(LOG_FILE_PATH, "utf-8");
  if (!text.trim()) return [];

  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as SoundPlayLogRecord[];
  } catch {
    // Handled below.
  }

  fs.renameSync(LOG_FILE_PATH, LOG_FILE_PATH.replace(/\.json$/, `.corrupt-${Date.now()}.json`));
  return [];
}

export function logSoundPlay(req: SoundPlayLogRequest): void {
  const record: SoundPlayLogRecord = {
    timestamp: new Date().toISOString(),
    sound: req.sound,
    guildId: req.guildId,
    channelId: req.channelId,
    source: req.source,
    trigger: req.trigger,
    userId: req.requestedBy?.userId ?? null,
    username: req.requestedBy?.username ?? null,
  };

  const logs = readExisting();
  logs.push(record);

  // Write to a temporary file and rename it over the log, so the dashboard (which polls this file)
  // never reads a half-written one.
  const tmp = `${LOG_FILE_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(logs, null, 2), "utf-8");
    fs.renameSync(tmp, LOG_FILE_PATH);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
