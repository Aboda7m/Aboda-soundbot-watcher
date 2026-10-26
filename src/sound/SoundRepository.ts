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
  [unknownKey: string]: unknown;
}

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
  #data: Db = { entrances: {}, guildEntrances: {}, exits: {}, ignoreList: [], sounds: [] };
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
