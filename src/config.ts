import { resolve } from "node:path";

export interface Config {
  token: string;
  port: number;
  host: string;
  accessKey: string;
  hideBots: boolean;
  soundsDir: string;
  dbPath: string;
  acceptedExtensions: string[];
  introsEnabled: boolean;
  introCooldownMs: number;
  maxQueuePerGuild: number;
  idleLeaveMs: number;
  countPlays: boolean;
}

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const flag = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v.trim() === "" ? fallback : v.trim() === "1" || v.trim().toLowerCase() === "true";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    token: env.DISCORD_TOKEN ?? "",
    port: num(env.PORT, 3939),
    host: env.HOST ?? "127.0.0.1",
    accessKey: env.ACCESS_KEY ?? "",
    hideBots: flag(env.HIDE_BOTS, false),
    soundsDir: resolve(env.SOUNDS_DIR ?? "./sounds"),
    dbPath: resolve(env.DB_PATH ?? "./db.json"),
    acceptedExtensions: (env.ACCEPTED_EXTENSIONS ?? ".mp3,.wav")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    introsEnabled: flag(env.INTROS_ENABLED, true),
    introCooldownMs: num(env.INTRO_COOLDOWN_MS, 3000),
    maxQueuePerGuild: Math.max(1, num(env.MAX_QUEUE_PER_GUILD, 10)),
    idleLeaveMs: num(env.IDLE_LEAVE_MS, 5000),
    countPlays: flag(env.COUNT_PLAYS, true),
  };
}
