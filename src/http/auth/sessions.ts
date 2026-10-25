import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface SessionUser {
  id: string;
  username: string;
}

export interface Session {
  id: string;
  user: SessionUser;
  createdAt: number;
  expiresAt: number;
}

export interface SessionStoreOptions {
  /** Absolute lifetime. There is no sliding window: a session never outlives this, however it is used. */
  maxAgeMs: number;
  maxSessions?: number;
  now?: () => number;
  sweepMs?: number;
  /**
   * JSON file that keeps sessions across restarts. Only a SHA-256 of each session id is written (never the id the
   * browser holds), the file is created readable by its owner only, and expired entries are dropped on load. Left out =
   * memory only, as before (the local listener uses that).
   */
  file?: string;
  log?: (msg: string, err?: unknown) => void;
}

interface Entry extends Session {
  closers: Set<() => void>;
}

const hashId = (id: string) => createHash("sha256").update(id).digest("base64url");
const KEY = /^[A-Za-z0-9_-]{43}$/;
const SNOWFLAKE = /^\d{15,25}$/;

/**
 * Server-side sessions. The browser only holds the random id; the map is keyed by its SHA-256. With `file` set the
 * sessions survive a restart (and expire on their absolute deadline); without it they live in memory only.
 */
export class SessionStore {
  #map = new Map<string, Entry>(); // key = sha256(session id)
  #opts: Required<Omit<SessionStoreOptions, "sweepMs" | "file" | "log">>;
  #file: string | undefined;
  #log: (msg: string, err?: unknown) => void;
  #timer: NodeJS.Timeout;

  constructor(opts: SessionStoreOptions) {
    const { file, log, sweepMs, ...rest } = opts;
    this.#opts = { maxSessions: 200, now: Date.now, ...rest };
    this.#file = file;
    this.#log = log ?? (() => {});
    this.#load();
    this.#timer = setInterval(() => this.sweep(), sweepMs ?? 60_000);
    this.#timer.unref();
  }

  create(user: SessionUser): Session {
    const now = this.#opts.now();
    while (this.#map.size >= this.#opts.maxSessions) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.destroy(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    const entry: Entry = { id, user, createdAt: now, expiresAt: now + this.#opts.maxAgeMs, closers: new Set() };
    this.#map.set(hashId(id), entry);
    this.#save();
    return this.#view(entry);
  }

  get(id: string): Session | null {
    const key = hashId(id); // always hashed: a stored hash presented as a cookie finds nothing
    const e = this.#map.get(key);
    if (!e) return null;
    if (this.#opts.now() >= e.expiresAt) {
      this.#remove(key);
      this.#save();
      return null;
    }
    return { ...this.#view(e), id };
  }

  /** Runs `closer` when the session ends (logout, expiry). Returns a function that detaches it. */
  attach(id: string, closer: () => void): () => void {
    const e = this.#map.get(this.#keyOf(id));
    if (!e) {
      closer();
      return () => {};
    }
    e.closers.add(closer);
    return () => e.closers.delete(closer);
  }

  /** Ends a session. Accepts the id the browser holds, or the `id` that `all()` reports (which, after a restart, is the stored hash). */
  destroy(id: string): boolean {
    const key = this.#keyOf(id);
    const gone = this.#remove(key);
    if (gone) this.#save();
    return gone;
  }

  sweep(): void {
    const now = this.#opts.now();
    let changed = false;
    for (const [key, e] of this.#map) if (now >= e.expiresAt) changed = this.#remove(key) || changed;
    if (changed) this.#save();
  }

  /** Snapshot of every live session (used by the periodic authorization recheck). */
  all(): Session[] {
    const now = this.#opts.now();
    return [...this.#map.values()].filter((e) => now < e.expiresAt).map((e) => this.#view(e));
  }

  get size(): number {
    return this.#map.size;
  }

  get maxAgeMs(): number {
    return this.#opts.maxAgeMs;
  }

  /** Stops the sweep and ends every live stream. A persistent store keeps its sessions: shutting down must not sign anybody out. */
  close(): void {
    clearInterval(this.#timer);
    for (const [key, e] of [...this.#map]) {
      for (const close of e.closers) {
        try {
          close();
        } catch {
          // keep closing the others
        }
      }
      e.closers.clear();
      if (!this.#file) this.#map.delete(key);
    }
  }

  #keyOf(id: string): string {
    return this.#map.has(id) ? id : hashId(id);
  }

  /** Removes one entry and ends its streams. Does not write the file. */
  #remove(key: string): boolean {
    const e = this.#map.get(key);
    if (!e) return false;
    this.#map.delete(key);
    for (const close of e.closers) {
      try {
        close();
      } catch {
        // a broken stream must not stop the others from closing
      }
    }
    e.closers.clear();
    return true;
  }

  #save(): void {
    if (!this.#file) return;
    try {
      const now = this.#opts.now();
      const sessions = [...this.#map]
        .filter(([, e]) => now < e.expiresAt)
        .map(([key, e]) => ({ key, user: e.user, createdAt: e.createdAt, expiresAt: e.expiresAt }));
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, sessions }) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch (err) {
      // Signing in must keep working; the session then only lasts until the next restart.
      this.#log(`Could not save sessions to ${this.#file}`, err);
    }
  }

  #load(): void {
    const file = this.#file;
    if (!file || !existsSync(file)) return;
    const now = this.#opts.now();
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; sessions?: unknown };
      if (raw?.version !== 1 || !Array.isArray(raw.sessions)) throw new Error("unrecognised format");
      for (const r of raw.sessions as Record<string, unknown>[]) {
        const u = r?.user as { id?: unknown; username?: unknown } | undefined;
        if (
          typeof r?.key !== "string" || !KEY.test(r.key) ||
          typeof u?.id !== "string" || !SNOWFLAKE.test(u.id) || typeof u.username !== "string" ||
          typeof r.createdAt !== "number" || typeof r.expiresAt !== "number" ||
          !Number.isFinite(r.createdAt) || !Number.isFinite(r.expiresAt)
        ) continue; // skip a bad entry, keep the rest
        // A shorter SESSION_MAX_HOURS than when the session was made applies to it too.
        const expiresAt = Math.min(r.expiresAt, r.createdAt + this.#opts.maxAgeMs);
        if (now >= expiresAt) continue;
        this.#map.set(r.key, {
          id: r.key, // no raw id after a restart: the stored hash doubles as the handle for destroy()
          user: { id: u.id, username: u.username.slice(0, 80) },
          createdAt: r.createdAt,
          expiresAt,
          closers: new Set(),
        });
      }
      while (this.#map.size > this.#opts.maxSessions) this.#remove(this.#map.keys().next().value as string);
    } catch (err) {
      // Sessions are expendable, but never delete what we could not read: set it aside and start empty.
      this.#log(`${file} could not be read (${(err as Error).message}); moved aside, everybody must sign in again`);
      try {
        renameSync(file, `${file}.unreadable`);
      } catch {
        // nothing more to do
      }
    }
  }

  #view(e: Entry): Session {
    return { id: e.id, user: e.user, createdAt: e.createdAt, expiresAt: e.expiresAt };
  }
}
