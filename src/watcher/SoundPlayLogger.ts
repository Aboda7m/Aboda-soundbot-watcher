import fs from "node:fs";
import path from "node:path";

const LOG_FILE_PATH = path.join(process.cwd(), "sound-play-logs.json");

export type SoundPlaySource = "manual" | "entrance" | "exit";
export type SoundPlayTrigger = "text-command" | "auto-entrance" | "auto-exit";

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

  let logs: SoundPlayLogRecord[] = [];

  if (fs.existsSync(LOG_FILE_PATH)) {
    try {
      const fileContent = fs.readFileSync(LOG_FILE_PATH, "utf-8");
      const parsed = JSON.parse(fileContent);
      logs = Array.isArray(parsed) ? (parsed as SoundPlayLogRecord[]) : [];
    } catch {
      logs = [];
    }
  }

  logs.push(record);
  fs.writeFileSync(LOG_FILE_PATH, JSON.stringify(logs, null, 2), "utf-8");
}
