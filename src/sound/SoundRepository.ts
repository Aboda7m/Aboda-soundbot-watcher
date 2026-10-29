import { copyFileSync, constants, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

/** Same shape the legacy lowdb file uses: { entrances, exits, ignoreList, sounds }. */
export interface SoundMeta {
  name: string;
  count: number;
  tags: string[];
}
interface Db {
  entrances: Record<string, string>;
  /** Guild-specific overrides; an empty string explicitly suppresses the user's personal entrance sound in that guild. */
  guildEntrances: Record<string, Record<string, string>>;
  exits: Record<string, string>;
  ignoreList: string[];
  sounds: SoundMeta[];
  /** User-owned guild preferences: missing key inherits global; "" explicitly disables. */
  userGuildEntrances: Record<string, Record<string, string>>;
  /** Optional duration caps in seconds, global user cap and per-guild caps. */
  entranceDurations: Record<string, number | null>;
  userGuildEntranceDurations: Record<string, Record<string, number | null>>;
  /** Guild-level automatic entrance policy and timing restrictions. */
  guildEntrancePolicy: Record<string, { enabled?: boolean; maxDurationSec?: number | null; reconnectGraceSec?: number | null; minReconnectGraceSec?: number | null; userCooldownSec?: number | null; enforcedUserCooldownSec?: number | null; guildCooldownSec?: number | null; allowUserTiming?: boolean; allowUserCooldown?: boolean }>;
  /** User-owned timing preferences. null explicitly disables reconnect suppression/cooldown. */
  userEntranceTiming: Record<string, { cooldownSec?: number | null; reconnectGraceSec?: number | null }>;
  userGuildEntranceTiming: Record<string, Record<string, { cooldownSec?: number | null; reconnectGraceSec?: number | null }>>;
  [unknownKey: string]: unknown;
}

const validDuration = (v: unknown): boolean => v === null || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 30);
const validTiming = (v: unknown): boolean => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  return Object.entries(t).every(([k, n]) => ["cooldownSec", "reconnectGraceSec"].includes(k) && (n === null || (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 86400)));
};
const validPolicy = (v: unknown): boolean => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return Object.entries(p).every(([k, n]) => {
    if (k === "enabled" || k === "allowUserTiming" || k === "allowUserCooldown") return typeof n === "boolean";
    if (k === "maxDurationSec") return validDuration(n);
    if (["reconnectGraceSec", "minReconnectGraceSec", "userCooldownSec", "enforcedUserCooldownSec", "guildCooldownSec"].includes(k)) return n === null || (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 86400);
    return true;
  });
};
const isRecordOfStrings = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

function validate(raw: unknown): Db {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("db.json root must be an object");
  const d = raw as Record<string, unknown>;
  d.entrances ??= {};
  d.guildEntrances ??= {};
  d.exits ??= {};
  d.ignoreList ??= [];
  d.sounds ??= [];
  d.userGuildEntrances ??= {};
  d.entranceDurations ??= {};
  d.userGuildEntranceDurations ??= {};
  d.guildEntrancePolicy ??= {};
  d.userEntranceTiming ??= {};
  d.userGuildEntranceTiming ??= {};
  if (!isRecordOfStrings(d.entrances)) throw new Error("db.json: 'entrances' must map user id -> sound name");
  if (typeof d.guildEntrances !== "object" || d.guildEntrances === null || Array.isArray(d.guildEntrances) ||
      !Object.values(d.guildEntrances as Record<string, unknown>).every(isRecordOfStrings))
    throw new Error("db.json: 'guildEntrances' must map guild id -> user id -> sound name");
  if (!isRecordOfStrings(d.exits)) throw new Error("db.json: 'exits' must map user id -> sound name");
  if (!Array.isArray(d.ignoreList)) throw new Error("db.json: 'ignoreList' must be an array");
  if (!Array.isArray(d.sounds)) throw new Error("db.json: 'sounds' must be an array");
  for (const s of d.sounds) {
    const m = s as Partial<SoundMeta>;
    if (typeof m?.name !== "string" || typeof m.count !== "number" || !Array.isArray(m.tags))
      throw new Error("db.json: every entry in 'sounds' needs name, count and tags");
  }
  for (const key of ["userGuildEntrances", "userGuildEntranceDurations", "userGuildEntranceTiming"] as const) {
    if (typeof d[key] !== "object" || d[key] === null || Array.isArray(d[key])) throw new Error(`db.json: '${key}' must be an object`);
  }
  if (!Object.values(d.userGuildEntrances as Record<string, unknown>).every(isRecordOfStrings)) throw new Error("db.json: 'userGuildEntrances' must map guild id -> user id -> sound name");
  if (!Object.values(d.userGuildEntranceDurations as Record<string, unknown>).every((v) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every(validDuration))) throw new Error("db.json: 'userGuildEntranceDurations' contains invalid duration caps");
  if (!Object.values(d.userEntranceTiming as Record<string, unknown>).every(validTiming) || !Object.values(d.userGuildEntranceTiming as Record<string, unknown>).every((v) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every(validTiming))) throw new Error("db.json: timing settings are invalid");
  if (!Object.values(d.guildEntrancePolicy as Record<string, unknown>).every(validPolicy)) throw new Error("db.json: guild entrance policy is invalid");
  if (typeof d.entranceDurations !== "object" || d.entranceDurations === null || Array.isArray(d.entranceDurations) ||
      !Object.values(d.entranceDurations as Record<string, unknown>).every(validDuration))
    throw new Error("db.json: 'entranceDurations' values must be null or integer seconds from 1 to 30");
  if (typeof d.guildEntrancePolicy !== "object" || d.guildEntrancePolicy === null || Array.isArray(d.guildEntrancePolicy)) throw new Error("db.json: 'guildEntrancePolicy' must be an object");
  if (typeof d.userEntranceTiming !== "object" || d.userEntranceTiming === null || Array.isArray(d.userEntranceTiming)) throw new Error("db.json: 'userEntranceTiming' must be an object");
  return d as Db;
}

/**
 * Reads the existing db.json in place. It never rewrites anything it did not change:
 * unknown keys are preserved, a malformed file is refused (not "fixed"), writes are atomic
 * (temp file + rename), and a .bak copy of the original is made before the first write.
 * Edits to db.json made while running are picked up automatically (mtime check).
 */
export class SoundRepository {
  #path: string;
  #countPlays: boolean;
  #data: Db = { entrances: {}, guildEntrances: {}, exits: {}, ignoreList: [], sounds: [], userGuildEntrances: {}, entranceDurations: {}, userGuildEntranceDurations: {}, guildEntrancePolicy: {}, userEntranceTiming: {}, userGuildEntranceTiming: {} };
  #mtime = -1;
  #dirty = false;
  #timer: NodeJS.Timeout | null = null;
  #backedUp = false;

  constructor(path: string, opts: { countPlays: boolean }) {
    this.#path = path;
    this.#countPlays = opts.countPlays;
    this.#load();
  }

  #load() {
    if (!existsSync(this.#path)) {
      this.#mtime = -1;
      return; // no file yet: start empty, create it only if something is written
    }
    const text = readFileSync(this.#path, "utf8").replace(/^\uFEFF/, "");
    this.#data = text.trim() === "" ? validate({}) : validate(JSON.parse(text));
    this.#mtime = statSync(this.#path).mtimeMs;
  }

  #reloadIfChanged() {
    if (this.#dirty) return; // never discard our own unsaved changes
    try {
      const m = existsSync(this.#path) ? statSync(this.#path).mtimeMs : -1;
      if (m !== this.#mtime) this.#load();
    } catch (err) {
      console.warn("db.json changed but could not be reloaded; keeping previous data:", (err as Error).message);
    }
  }

  entrance(userId: string, guildId?: string): string | undefined {
    this.#reloadIfChanged();
    if (guildId && Object.hasOwn(this.#data.guildEntrances[guildId] ?? {}, userId)) {
      return this.#data.guildEntrances[guildId][userId] || undefined;
    }
    return this.#data.entrances[userId] || undefined;
  }

  hasGuildEntranceOverride(userId: string, guildId: string): boolean {
    this.#reloadIfChanged();
    return Object.hasOwn(this.#data.guildEntrances[guildId] ?? {}, userId);
  }

  /** Sets a guild-specific override, without changing the user's personal entrance sound. */
  setGuildEntrance(guildId: string, userId: string, sound: string): void {
    this.#reloadIfChanged();
    this.#data.guildEntrances[guildId] ??= {};
    this.#data.guildEntrances[guildId][userId] = sound;
    this.#dirty = true;
    this.flush();
  }

  /** Suppresses entrance sounds for this member in this guild, even if they have a personal sound. */
  clearGuildEntrance(guildId: string, userId: string): boolean {
    this.#reloadIfChanged();
    this.#data.guildEntrances[guildId] ??= {};
    if (this.#data.guildEntrances[guildId][userId] === "") return false;
    this.#data.guildEntrances[guildId][userId] = "";
    this.#dirty = true;
    this.flush();
    return true;
  }

  /** Raw admin assignment: undefined = no override, empty string = explicit suppression. */
  guildEntranceAssignment(userId: string, guildId: string): string | undefined {
    this.#reloadIfChanged();
    const map = this.#data.guildEntrances[guildId];
    return map && Object.hasOwn(map, userId) ? map[userId] : undefined;
  }

  /** Delete the admin override. Unlike clearGuildEntrance, this does not suppress. */
  releaseGuildEntrance(guildId: string, userId: string): boolean {
    this.#reloadIfChanged();
    const map = this.#data.guildEntrances[guildId];
    if (!map || !Object.hasOwn(map, userId)) return false;
    delete map[userId];
    if (Object.keys(map).length === 0) delete this.#data.guildEntrances[guildId];
    this.#dirty = true; this.flush(); return true;
  }

  userGuildEntrance(userId: string, guildId: string): string | undefined {
    this.#reloadIfChanged();
    const map = this.#data.userGuildEntrances[guildId];
    return map && Object.hasOwn(map, userId) ? map[userId] : undefined;
  }
  setUserGuildEntrance(userId: string, guildId: string, sound: string | null): void {
    this.#reloadIfChanged(); this.#data.userGuildEntrances[guildId] ??= {};
    if (sound === null) { delete this.#data.userGuildEntrances[guildId][userId]; if (!Object.keys(this.#data.userGuildEntrances[guildId]).length) delete this.#data.userGuildEntrances[guildId]; }
    else this.#data.userGuildEntrances[guildId][userId] = sound;
    this.#dirty = true; this.flush();
  }
  userEntranceDuration(userId: string, guildId?: string): number | null | undefined {
    this.#reloadIfChanged();
    if (guildId && Object.hasOwn(this.#data.userGuildEntranceDurations[guildId] ?? {}, userId)) return this.#data.userGuildEntranceDurations[guildId][userId];
    return Object.hasOwn(this.#data.entranceDurations, userId) ? this.#data.entranceDurations[userId] : undefined;
  }
  setUserEntranceDuration(userId: string, seconds: number | null, guildId?: string): void {
    if (!validDuration(seconds)) throw new Error("Duration must be null or an integer from 1 to 30 seconds");
    this.#reloadIfChanged();
    if (guildId) { this.#data.userGuildEntranceDurations[guildId] ??= {}; if (seconds === null) delete this.#data.userGuildEntranceDurations[guildId][userId]; else this.#data.userGuildEntranceDurations[guildId][userId] = seconds; if (!Object.keys(this.#data.userGuildEntranceDurations[guildId]).length) delete this.#data.userGuildEntranceDurations[guildId]; }
    else if (seconds === null) delete this.#data.entranceDurations[userId]; else this.#data.entranceDurations[userId] = seconds;
    this.#dirty = true; this.flush();
  }
  guildEntranceSettings(guildId: string) { this.#reloadIfChanged(); return { ...(this.#data.guildEntrancePolicy[guildId] ?? {}) }; }
  setGuildEntranceSettings(guildId: string, patch: Record<string, unknown>): void {
    this.#reloadIfChanged(); const current = this.#data.guildEntrancePolicy[guildId] ?? {};
    const next = { ...current, ...patch };
    for (const key of ["maxDurationSec"] as const) if (key in next && !validDuration(next[key])) throw new Error(`${key} must be null or an integer from 1 to 30`);
    for (const key of ["reconnectGraceSec", "minReconnectGraceSec", "userCooldownSec", "enforcedUserCooldownSec", "guildCooldownSec"] as const) if (key in next && next[key] !== null && (!Number.isInteger(next[key]) || (next[key] as number) < 0 || (next[key] as number) > 86400)) throw new Error(`${key} must be null or integer seconds from 0 to 86400`);
    if ("enabled" in next && typeof next.enabled !== "boolean") throw new Error("enabled must be boolean");
    if ("allowUserTiming" in next && typeof next.allowUserTiming !== "boolean") throw new Error("allowUserTiming must be boolean");
    if ("allowUserCooldown" in next && typeof next.allowUserCooldown !== "boolean") throw new Error("allowUserCooldown must be boolean");
    this.#data.guildEntrancePolicy[guildId] = next; this.#dirty = true; this.flush();
  }
  userEntranceTiming(userId: string, guildId?: string) {
    this.#reloadIfChanged();
    return { ...(this.#data.userEntranceTiming[userId] ?? {}), ...(guildId ? this.#data.userGuildEntranceTiming[guildId]?.[userId] ?? {} : {}) };
  }
  setUserEntranceTiming(userId: string, patch: { cooldownSec?: number | null; reconnectGraceSec?: number | null }, guildId?: string): void {
    for (const [key, value] of Object.entries(patch)) if (value !== null && (!Number.isInteger(value) || value < 0 || value > 86400)) throw new Error(`${key} must be null or integer seconds from 0 to 86400`);
    this.#reloadIfChanged();
    if (guildId) { this.#data.userGuildEntranceTiming[guildId] ??= {}; this.#data.userGuildEntranceTiming[guildId][userId] = { ...(this.#data.userGuildEntranceTiming[guildId][userId] ?? {}), ...patch }; }
    else this.#data.userEntranceTiming[userId] = { ...(this.#data.userEntranceTiming[userId] ?? {}), ...patch };
    this.#dirty = true; this.flush();
  }

  /** Sets a user's personal entrance sound and saves immediately. Other db.json data is left untouched. */
  setEntrance(userId: string, sound: string): void {
    this.#reloadIfChanged();
    this.#data.entrances[userId] = sound;
    this.#dirty = true;
    this.flush();
  }

  /** Removes a user's entrance sound and saves immediately. Returns false when none was set. */
  clearEntrance(userId: string): boolean {
    this.#reloadIfChanged();
    if (!Object.hasOwn(this.#data.entrances, userId)) return false;
    delete this.#data.entrances[userId];
    this.#dirty = true;
    this.flush();
    return true;
  }

  exit(userId: string): string | undefined {
    this.#reloadIfChanged();
    return this.#data.exits[userId] || undefined;
  }

  sounds(): SoundMeta[] {
    this.#reloadIfChanged();
    return this.#data.sounds.map((s) => ({ ...s, tags: [...s.tags] }));
  }

  recordPlay(name: string) {
    if (!this.#countPlays) return;
    let entry = this.#data.sounds.find((s) => s.name === name);
    if (!entry) {
      entry = { name, count: 0, tags: [] };
      this.#data.sounds.push(entry);
    }
    entry.count += 1;
    this.#dirty = true;
    this.#timer ??= setTimeout(() => this.flush(), 2000);
    this.#timer.unref();
  }

  flush() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#dirty) return;
    try {
      if (!this.#backedUp && existsSync(this.#path)) {
        try {
          copyFileSync(this.#path, `${this.#path}.bak`, constants.COPYFILE_EXCL);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        this.#backedUp = true;
      }
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#data, null, 2));
      renameSync(tmp, this.#path);
      this.#mtime = statSync(this.#path).mtimeMs;
      this.#dirty = false;
    } catch (err) {
      console.error("Could not save db.json (will retry on next change):", (err as Error).message);
    }
  }
}
