import { randomUUID } from "node:crypto";
import type { VoicePort } from "../voice/VoicePort.ts";
import { logSoundPlay } from "../watcher/SoundPlayLogger.ts";

export type PlaySource = "entrance" | "exit" | "manual";

export interface PlayRequest {
  sound: string;
  guildId: string;
  channelId: string;
  source: PlaySource;
  requestedBy?: { userId: string; username?: string | null } | null;
}

export interface QueueItem extends PlayRequest {
  id: string;
}

export type EnqueueResult =
  | { ok: true; position: number }
  | {
      ok: false;
      reason:
        | "unknown-sound"
        | "queue-full"
        | "duplicate"
        | "shutting-down";
    };

export interface GuildPlayback {
  guildId: string;
  current: QueueItem | null;
  queued: number;
  items: QueueItem[];
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
  items: QueueItem[];
  current: QueueItem | null;
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
    if (this.#closed) {
      return { ok: false, reason: "shutting-down" };
    }

    if (!this.#d.resolvePath(req.sound)) {
      return { ok: false, reason: "unknown-sound" };
    }

    const g = this.#state(req.guildId);

    if (
      g.items.some(
        (i) => i.sound === req.sound && i.channelId === req.channelId,
      )
    ) {
      return { ok: false, reason: "duplicate" };
    }

    if (g.items.length >= this.#d.maxPerGuild) {
      return { ok: false, reason: "queue-full" };
    }

    if (g.idleTimer) {
      clearTimeout(g.idleTimer);
      g.idleTimer = null;
    }

    const item: QueueItem = { ...req, id: randomUUID() };
    g.items.push(item);

    const position = g.items.length + (g.current ? 1 : 0);

    this.#d.onChange?.();

    if (!g.running) {
      void this.#pump(req.guildId, g);
    }

    return { ok: true, position };
  }

  /** Skip the currently playing sound without clearing pending items. */
  skip(guildId: string): void {
    this.skipCurrent(guildId);
  }

  /** Stop the current sound, if one is actually playing. */
  skipCurrent(guildId: string): boolean {
    const g = this.#guilds.get(guildId);

    if (!g?.current) {
      return false;
    }

    this.#d.voice.stop(guildId);
    return true;
  }

  /** Remove one pending item. The currently playing sound cannot be removed this way. */
  removeQueued(guildId: string, id: string): boolean {
    const g = this.#guilds.get(guildId);
    if (!g) return false;

    const index = g.items.findIndex((item) => item.id === id);
    if (index === -1) return false;

    g.items.splice(index, 1);
    this.#d.onChange?.();

    return true;
  }

  /** Remove all pending items without interrupting the current sound. */
  clearPending(guildId: string): void {
    const g = this.#guilds.get(guildId);
    if (!g || g.items.length === 0) return;

    g.items.length = 0;
    this.#d.onChange?.();
  }

  /** Drop everything waiting and stop the current sound. */
  clear(guildId: string): void {
    const g = this.#guilds.get(guildId);
    if (!g) return;

    g.items.length = 0;
    this.#d.voice.stop(guildId);
    this.#d.onChange?.();
  }

  status(): GuildPlayback[] {
    const out: GuildPlayback[] = [];

    for (const [guildId, g] of this.#guilds) {
      if (g.current || g.items.length) {
        out.push({
          guildId,
          current: g.current,
          queued: g.items.length,
          items: [...g.items],
        });
      }
    }

    return out;
  }

  shutdown(): void {
    this.#closed = true;

    for (const [guildId, g] of this.#guilds) {
      g.items.length = 0;

      if (g.idleTimer) {
        clearTimeout(g.idleTimer);
        g.idleTimer = null;
      }

      this.#d.voice.stop(guildId);
    }

    this.#d.voice.destroyAll();
  }

  #state(guildId: string): GuildState {
    let g = this.#guilds.get(guildId);

    if (!g) {
      g = {
        items: [],
        current: null,
        running: false,
        idleTimer: null,
      };

      this.#guilds.set(guildId, g);
    }

    return g;
  }

  async #pump(guildId: string, g: GuildState): Promise<void> {
    g.running = true;

    try {
      while (g.items.length > 0 && !this.#closed) {
        const req = g.items.shift()!;
        g.current = req;
        this.#d.onChange?.();

        try {
          const path = this.#d.resolvePath(req.sound);

          if (!path) {
            throw new Error(`Sound "${req.sound}" no longer exists`);
          }

          await this.#d.voice.play(guildId, req.channelId, path);
          this.#d.onPlayed?.(req.sound);

          // Log successfully played sound
          const trigger =
            req.source === "manual"
              ? "text-command"
              : req.source === "entrance"
                ? "auto-entrance"
                : "auto-exit";

          logSoundPlay({
            sound: req.sound,
            guildId: req.guildId,
            channelId: req.channelId,
            source: req.source,
            trigger,
            requestedBy: req.requestedBy ?? null,
          });
        } catch (err) {
          this.#d.log?.(
            `Could not play "${req.sound}" in guild ${guildId}`,
            err,
          );
        } finally {
          g.current = null;
          this.#d.onChange?.();
        }
      }
    } finally {
      g.running = false;

      if (!this.#closed) {
        this.#scheduleLeave(guildId, g);
      }
    }
  }

  #scheduleLeave(guildId: string, g: GuildState): void {
    if (g.items.length > 0) return;

    const leave = () => {
      g.idleTimer = null;

      if (!g.running && g.items.length === 0) {
        this.#d.voice.leave(guildId);
      }
    };

    if (this.#d.idleLeaveMs <= 0) {
      leave();
      return;
    }

    g.idleTimer = setTimeout(leave, this.#d.idleLeaveMs);
    g.idleTimer.unref();
  }
}