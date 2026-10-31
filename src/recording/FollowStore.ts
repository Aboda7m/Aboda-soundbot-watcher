import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One `!record attach` registration as it is kept on disk. */
export interface PersistedFollow {
  guildId: string;
  targetId: string;
  initiatedBy: string;
  initiatedByName?: string;
  /** The text channel `attach` ran in, so automatic notices keep going there after a restart. */
  notifyChannelId?: string;
  createdAt: string;
}

export interface FollowStorePort {
  all(): PersistedFollow[];
  set(entry: PersistedFollow): void;
  remove(guildId: string): void;
}

const isEntry = (v: unknown): v is PersistedFollow => {
  const e = v as Partial<PersistedFollow> | null;
  return !!e && typeof e.guildId === "string" && typeof e.targetId === "string" && typeof e.initiatedBy === "string";
};

/**
 * Follow registrations kept in a small JSON file (one per guild) so `!record attach` survives a restart.
 * Written only when someone attaches or detaches, never on shutdown, so a restart keeps every follow.
 * Writes are synchronous (tiny file, rare) and atomic (temp file + rename).
 */
export class FollowStore implements FollowStorePort {
  readonly #path: string;
  readonly #log: (message: string, err?: unknown) => void;
  readonly #entries = new Map<string, PersistedFollow>();

  constructor(path: string, log: (message: string, err?: unknown) => void = console.error) {
    this.#path = path;
    this.#log = log;
    this.#load();
  }

  all(): PersistedFollow[] {
    return [...this.#entries.values()];
  }

  set(entry: PersistedFollow): void {
    this.#entries.set(entry.guildId, entry);
    this.#save();
  }

  remove(guildId: string): void {
    if (this.#entries.delete(guildId)) this.#save();
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const data = JSON.parse(readFileSync(this.#path, "utf8")) as { follows?: unknown };
      if (!Array.isArray(data.follows)) throw new Error("missing \"follows\" array");
      for (const e of data.follows) if (isEntry(e)) this.#entries.set(e.guildId, e);
    } catch (err) {
      // Never overwrite something we could not read: keep it aside and start empty.
      const aside = `${this.#path}.corrupt-${Date.now()}`;
      try {
        renameSync(this.#path, aside);
      } catch {
        /* nothing more we can do */
      }
      this.#log(`Follow file ${this.#path} is unreadable; moved to ${aside} and starting empty`, err);
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, follows: this.all() }, null, 2)}\n`, "utf8");
      renameSync(tmp, this.#path);
    } catch (err) {
      this.#log("Could not save the follow list (follows still work until restart)", err);
    }
  }
}
