import { randomUUID } from "node:crypto";
import type { VoicePort } from "../voice/VoicePort.ts";
import { logSoundPlay, type SoundPlayTrigger } from "../watcher/SoundPlayLogger.ts";

export type PlaySource = "entrance" | "exit" | "manual";

export interface PlayRequest {
  sound: string;
  guildId: string;
  channelId: string;
  source: PlaySource;
  /** How the request arrived, for the play log. Left out = derived from `source`. */
  trigger?: SoundPlayTrigger;
  requestedBy?: { userId: string; username?: string | null } | null;
  /** Automatic entrance-only cap. Ignored for manual and exit requests. */
  maxDurationSec?: number;
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
  channelId: string;
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
  onStarted?(item: QueueItem): void;
  onFinished?(item: QueueItem, succeeded: boolean): void;
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
 * Serialises playback per voice channel. Different channels, including channels in the same guild, run independently.
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

    const key = this.#key(req.guildId, req.channelId);
    const g = this.#state(req.guildId, req.channelId);

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
      void this.#pump(key, req.guildId, req.channelId, g);
    }

    return { ok: true, position };
  }

  /** Skip the currently playing sound without clearing pending items. */
  skip(guildId: string): void {
    this.skipCurrent(guildId);
  }

  /** Stop the current sound, if one is actually playing. */
  skipCurrent(guildId: string): boolean {
    const g = [...this.#guilds.entries()].find(([key, state]) => key.startsWith(`${guildId}:`) && state.current)?.[1];

    if (!g?.current) {
      return false;
    }

    this.#d.voice.stop(guildId, g.current.channelId);
    return true;
  }

  /** Remove one pending item. The currently playing sound cannot be removed this way. */
  removeQueued(guildId: string, id: string): boolean {
    for (const [key, g] of this.#guilds) {
      if (!key.startsWith(`${guildId}:`)) continue;
      const index = g.items.findIndex((item) => item.id === id);
      if (index === -1) continue;
      const [removed] = g.items.splice(index, 1);
      if (removed) this.#d.onFinished?.(removed, false);
      this.#d.onChange?.();
      return true;
    }
    return false;
  }

  /** Remove all pending items without interrupting the current sound. */
  clearPending(guildId: string): void {
    let changed = false;
    for (const [key, g] of this.#guilds) {
      if (!key.startsWith(`${guildId}:`) || g.items.length === 0) continue;
      for (const item of g.items.splice(0)) this.#d.onFinished?.(item, false);
      changed = true;
    }
    if (changed) this.#d.onChange?.();
  }

  /** Drop everything waiting and stop the current sound. */
  clear(guildId: string): void {
    for (const [key, g] of this.#guilds) {
      if (!key.startsWith(`${guildId}:`)) continue;
      for (const item of g.items.splice(0)) this.#d.onFinished?.(item, false);
      if (g.current) this.#d.voice.stop(guildId, g.current.channelId);
    }
    this.#d.onChange?.();
  }

  status(): GuildPlayback[] {
    const out: GuildPlayback[] = [];

    for (const g of this.#guilds.values()) {
      if (g.current || g.items.length) {
        out.push({
          guildId: g.current?.guildId ?? g.items[0]!.guildId,
          channelId: g.current?.channelId ?? g.items[0]!.channelId,
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

    for (const [key, g] of this.#guilds) {
      const guildId = g.current?.guildId ?? g.items[0]?.guildId ?? key.split(":", 1)[0]!;
      for (const item of g.items.splice(0)) this.#d.onFinished?.(item, false);

      if (g.idleTimer) {
        clearTimeout(g.idleTimer);
        g.idleTimer = null;
      }

      this.#d.voice.stop(guildId);
    }

    this.#d.voice.destroyAll();
  }

  #key(guildId: string, channelId: string): string { return `${guildId}:${channelId}`; }

  #state(guildId: string, channelId: string): GuildState {
    const key = this.#key(guildId, channelId);
    let g = this.#guilds.get(key);

    if (!g) {
      g = {
        items: [],
        current: null,
        running: false,
        idleTimer: null,
      };

      this.#guilds.set(key, g);
    }

    return g;
  }

  async #pump(key: string, guildId: string, channelId: string, g: GuildState): Promise<void> {
    g.running = true;

    try {
      while (g.items.length > 0 && !this.#closed) {
        const req = g.items.shift()!;
        g.current = req;
        this.#d.onChange?.();

        let succeeded = false;
        try {
          const path = this.#d.resolvePath(req.sound);

          if (!path) {
            throw new Error(`Sound "${req.sound}" no longer exists`);
          }

          await this.#d.voice.play(guildId, req.channelId, path, req.source === "entrance" ? req.maxDurationSec : undefined, () => this.#d.onStarted?.(req));
          succeeded = true;
          this.#d.onPlayed?.(req.sound);
          this.#recordPlay(req);
        } catch (err) {
          this.#d.log?.(
            `Could not play "${req.sound}" in guild ${guildId}`,
            err,
          );
        } finally {
          this.#d.onFinished?.(req, succeeded);
          g.current = null;
          this.#d.onChange?.();
        }
      }
    } finally {
      g.running = false;

      if (!this.#closed) {
        this.#scheduleLeave(guildId, channelId, g);
      }
    }
  }

  /**
   * Called once per sound, only after `voice.play` resolved. A problem writing the log is reported
   * as such: it must not be mistaken for (or interrupt) playback.
   */
  #recordPlay(req: QueueItem): void {
    const trigger: SoundPlayTrigger =
      req.trigger ??
      (req.source === "manual"
        ? "text-command"
        : req.source === "entrance"
          ? "auto-entrance"
          : "auto-exit");

    try {
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
        `Played "${req.sound}" in guild ${req.guildId} but could not write the play log`,
        err,
      );
    }
  }

  #scheduleLeave(guildId: string, channelId: string, g: GuildState): void {
    if (g.items.length > 0) return;

    const leave = () => {
      g.idleTimer = null;

      if (!g.running && g.items.length === 0) {
        this.#d.voice.leave(guildId, channelId);
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