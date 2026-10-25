import { randomBytes } from "node:crypto";

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
}

interface Entry extends Session {
  closers: Set<() => void>;
}

/** Server-side sessions, in memory only: a restart signs everybody out. The browser only holds the random id. */
export class SessionStore {
  #map = new Map<string, Entry>();
  #opts: Required<Omit<SessionStoreOptions, "sweepMs">>;
  #timer: NodeJS.Timeout;

  constructor(opts: SessionStoreOptions) {
    this.#opts = { maxSessions: 200, now: Date.now, ...opts };
    this.#timer = setInterval(() => this.sweep(), opts.sweepMs ?? 60_000);
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
    this.#map.set(id, entry);
    return this.#view(entry);
  }

  get(id: string): Session | null {
    const e = this.#map.get(id);
    if (!e) return null;
    if (this.#opts.now() >= e.expiresAt) {
      this.destroy(id);
      return null;
    }
    return this.#view(e);
  }

  /** Runs `closer` when the session ends (logout, expiry). Returns a function that detaches it. */
  attach(id: string, closer: () => void): () => void {
    const e = this.#map.get(id);
    if (!e) {
      closer();
      return () => {};
    }
    e.closers.add(closer);
    return () => e.closers.delete(closer);
  }

  destroy(id: string): boolean {
    const e = this.#map.get(id);
    if (!e) return false;
    this.#map.delete(id);
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

  sweep(): void {
    const now = this.#opts.now();
    for (const [id, e] of this.#map) if (now >= e.expiresAt) this.destroy(id);
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

  close(): void {
    clearInterval(this.#timer);
    for (const id of [...this.#map.keys()]) this.destroy(id);
  }

  #view(e: Entry): Session {
    return { id: e.id, user: e.user, createdAt: e.createdAt, expiresAt: e.expiresAt };
  }
}
