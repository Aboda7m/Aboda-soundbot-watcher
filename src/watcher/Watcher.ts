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
  #sse = new Set<ServerResponse>();
  #last = "";
  #timer: NodeJS.Timeout | null = null;
  #heartbeat: NodeJS.Timeout;

  constructor(client: Client, opts: WatcherOptions) {
    this.#client = client;
    this.#opts = opts;
    
    for (const ev of REFRESH_EVENTS) {
      client.on(ev as string, (...args) => {
        // Intercept voice state updates to run the dedicated logger file
        if (ev === Events.VoiceStateUpdate) {
          const [oldState, newState] = args;
          try {
            trackVoiceActivity(oldState, newState);
          } catch (err) {
            console.error("Failed to log voice activity:", err);
          }
        }
        this.schedule();
      });
    }

    this.#heartbeat = setInterval(() => {
      for (const res of this.#sse) res.write(": ping\n\n");
    }, 25_000);
    this.#heartbeat.unref();
  }

  payloadJson(): string {
    return JSON.stringify({
      ...buildSnapshot(this.#client, this.#opts.hideBots),
      playback: this.#opts.extra?.() ?? null,
    });
  }

  addClient(res: ServerResponse) {
    res.write(`retry: 3000\ndata: ${this.payloadJson()}\n\n`);
    this.#sse.add(res);
    res.on("close", () => this.#sse.delete(res));
  }

  /** Coalesce bursts, then push only if something visible changed. */
  schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const json = this.payloadJson();
      if (json === this.#last) return;
      this.#last = json;
      for (const res of this.#sse) res.write(`data: ${json}\n\n`);
    }, 250);
  }

  close() {
    clearInterval(this.#heartbeat);
    if (this.#timer) clearTimeout(this.#timer);
    for (const res of this.#sse) res.end();
    this.#sse.clear();
  }
}