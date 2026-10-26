import { Events, type Client } from "discord.js";
import type { ServerResponse } from "node:http";
import { buildSnapshot } from "./snapshot.ts";
import { trackVoiceActivity } from "./VoiceActivityLogger.ts";

const REFRESH_EVENTS = [
  Events.ClientReady,
  Events.VoiceStateUpdate,
  Events.GuildCreate,
  Events.GuildDelete,
  Events.GuildUnavailable,
  Events.GuildUpdate,
  Events.GuildMemberAdd,
  Events.GuildMemberRemove,
  Events.ChannelUpdate,
  Events.ChannelDelete,
  Events.ShardDisconnect,
  Events.ShardReconnecting,
  Events.ShardResume,
] as const;

export interface WatcherOptions {
  hideBots: boolean;
  /** Extra JSON-serialisable data merged into every pushed payload (e.g. playback status). */
  extra?: () => Record<string, unknown>;
}

/** Builds snapshots on Discord events and pushes them to browsers via Server-Sent Events. */
export class Watcher {
  #client: Client;
  #opts: WatcherOptions;
  #sse = new Map<ServerResponse, (() => Promise<readonly string[]>) | null>();
  #last = "";
  #timer: NodeJS.Timeout | null = null;
  #heartbeat: NodeJS.Timeout;

  constructor(client: Client, opts: WatcherOptions) {
    this.#client = client;
    this.#opts = opts;

    for (const ev of REFRESH_EVENTS) {
      client.on(ev as string, (...args) => {
        if (ev === Events.VoiceStateUpdate) {
          const [oldState, newState] = args;
          try {
            trackVoiceActivity(oldState, newState);
          } catch (err) {
            console.error("Failed to log voice activity:", err);
          }
        }
        this.schedule(ev === Events.GuildMemberAdd || ev === Events.GuildMemberRemove);
      });
    }

    this.#heartbeat = setInterval(() => {
      for (const res of this.#sse.keys()) res.write(": ping\n\n");
    }, 25_000);
    this.#heartbeat.unref();
  }

  payloadJson(allowedGuildIds?: readonly string[]): string {
    const allowed = allowedGuildIds ? new Set(allowedGuildIds) : undefined;
    const snapshot = buildSnapshot(this.#client, this.#opts.hideBots, allowed);
    const extra = this.#opts.extra?.() ?? null;
    if (allowed && extra && typeof extra === "object") {
      const playing = (extra as { playing?: unknown }).playing;
      if (Array.isArray(playing)) {
        (extra as { playing: unknown[] }).playing = playing.filter(
          (item) => !!item && typeof item === "object" && allowed.has(String((item as { guildId?: unknown }).guildId)),
        );
      }
    }
    return JSON.stringify({ ...snapshot, playback: extra });
  }

  async addClient(res: ServerResponse, getAllowedGuildIds?: () => Promise<readonly string[]>) {
    const allowed = getAllowedGuildIds ? await getAllowedGuildIds() : undefined;
    if (res.destroyed || res.writableEnded) return;
    res.write(`retry: 3000\ndata: ${this.payloadJson(allowed)}\n\n`);
    this.#sse.set(res, getAllowedGuildIds ?? null);
    res.on("close", () => this.#sse.delete(res));
  }

  /** Coalesce bursts, then push each client only the guilds it is allowed to see. */
  schedule(force = false) {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const globalJson = this.payloadJson();
      if (globalJson === this.#last && !force) return;
      this.#last = globalJson;
      for (const [res, getAllowedGuildIds] of this.#sse) {
        void (async () => {
          try {
            const allowed = getAllowedGuildIds ? await getAllowedGuildIds() : undefined;
            if (!res.destroyed && !res.writableEnded) res.write(`data: ${this.payloadJson(allowed)}\n\n`);
          } catch {
            // Never fall back to an unfiltered event if membership cannot be verified.
            if (!res.destroyed && !res.writableEnded) res.end();
            this.#sse.delete(res);
          }
        })();
      }
    }, 250);
  }

  close() {
    clearInterval(this.#heartbeat);
    if (this.#timer) clearTimeout(this.#timer);
    for (const res of this.#sse.keys()) res.end();
    this.#sse.clear();
  }
}
