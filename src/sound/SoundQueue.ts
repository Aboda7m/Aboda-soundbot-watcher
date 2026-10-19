import type { VoicePort } from "../voice/VoicePort.ts";

export type PlaySource = "entrance" | "exit" | "manual";
export interface PlayRequest {
  sound: string;
  guildId: string;
  channelId: string;
  source: PlaySource;
}
export type EnqueueResult =
  | { ok: true; position: number }
  | { ok: false; reason: "unknown-sound" | "queue-full" | "duplicate" | "shutting-down" };

export interface GuildPlayback {
  guildId: string;
  current: PlayRequest | null;
  queued: number;
}

export interface SoundQueueDeps {
  voice: VoicePort;
  /** sound name -> file path, or null if unknown */
  resolvePath(name: string): string | null;
  maxPerGuild: number;
  /** stay in the channel this long after the last sound; 0 leaves immediately */
  idleLeaveMs: number;
  onPlayed?(name: string): void;
  onChange?(): void;
  log?(message: string, err?: unknown): void;
}

interface GuildState {
  items: PlayRequest[];
  current: PlayRequest | null;
  running: boolean;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Serialises playback: one sound at a time per guild, different guilds in parallel.
 * A failing sound is logged and skipped; it never blocks the queue or crashes the process.
 */
export class SoundQueue {
  #d: SoundQueueDeps;
  #guilds = new Map<string, GuildState>();
  #closed = false;

  constructor(deps: SoundQueueDeps) {
    this.#d = deps;
  }

  enqueue(req: PlayRequest): EnqueueResult {
    if (this.#closed) return { ok: false, reason: "shutting-down" };
    if (!this.#d.resolvePath(req.sound)) return { ok: false, reason: "unknown-sound" };

    const g = this.#state(req.guildId);
    if (g.items.some((i) => i.sound === req.sound && i.channelId === req.channelId))
      return { ok: false, reason: "duplicate" };
    if (g.items.length >= this.#d.maxPerGuild) return { ok: false, reason: "queue-full" };

    if (g.idleTimer) {
      clearTimeout(g.idleTimer);
      g.idleTimer = null;
    }
    g.items.push(req);
    const position = g.items.length + (g.current ? 1 : 0);
    this.#d.onChange?.();
    if (!g.running) void this.#pump(req.guildId, g);
    return { ok: true, position };
  }

  /** Skip the sound that is playing now. */
  skip(guildId: string) {
    this.#d.voice.stop(guildId);
  }

  /** Drop everything waiting and stop the current sound. */
  clear(guildId: string) {
    const g = this.#guilds.get(guildId);
    if (!g) return;
    g.items.length = 0;
    this.#d.voice.stop(guildId);
    this.#d.onChange?.();
  }

  status(): GuildPlayback[] {
    const out: GuildPlayback[] = [];
    for (const [guildId, g] of this.#guilds)
      if (g.current || g.items.length) out.push({ guildId, current: g.current, queued: g.items.length });
    return out;
  }

  shutdown() {
    this.#closed = true;
    for (const [guildId, g] of this.#guilds) {
      g.items.length = 0;
      if (g.idleTimer) clearTimeout(g.idleTimer);
      this.#d.voice.stop(guildId);
    }
    this.#d.voice.destroyAll();
  }

  #state(guildId: string): GuildState {
    let g = this.#guilds.get(guildId);
    if (!g) {
      g = { items: [], current: null, running: false, idleTimer: null };
      this.#guilds.set(guildId, g);
    }
    return g;
  }

  async #pump(guildId: string, g: GuildState) {
    g.running = true;
    try {
      while (g.items.length > 0 && !this.#closed) {
        const req = g.items.shift()!;
        g.current = req;
        this.#d.onChange?.();
        try {
          const path = this.#d.resolvePath(req.sound);
          if (!path) throw new Error(`Sound "${req.sound}" no longer exists`);
          await this.#d.voice.play(guildId, req.channelId, path);
          this.#d.onPlayed?.(req.sound);
        } catch (err) {
          this.#d.log?.(`Could not play "${req.sound}" in guild ${guildId}`, err);
        } finally {
          g.current = null;
          this.#d.onChange?.();
        }
      }
    } finally {
      g.running = false;
      if (!this.#closed) this.#scheduleLeave(guildId, g);
    }
  }

  #scheduleLeave(guildId: string, g: GuildState) {
    if (g.items.length > 0) return;
    const leave = () => {
      g.idleTimer = null;
      if (!g.running && g.items.length === 0) this.#d.voice.leave(guildId);
    };
    if (this.#d.idleLeaveMs <= 0) return leave();
    g.idleTimer = setTimeout(leave, this.#d.idleLeaveMs);
    g.idleTimer.unref();
  }
}
