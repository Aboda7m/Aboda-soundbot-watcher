import type { VoiceConnection } from "@discordjs/voice";
import type { VoicePort } from "./VoicePort.ts";

/**
 * Several bot accounts, one voice pool.
 *
 * Discord allows ONE voice connection per bot account per server. So "two people in two voice channels of the
 * same server, each greeted at the same time" needs two bot accounts: the main bot plus extra "voice workers"
 * (separate bot tokens, invited to the server). The hub is the only place that knows about that: the sound queue
 * keeps asking for `play(guild, channel, file)` and the hub picks a free bot for that channel.
 *
 * With only the main bot configured the hub has one slot and behaves exactly like talking to the adapter directly
 * (a second channel of the same server waits for the first to finish).
 *
 * Recording asks for a bot of its own (`leaseRecording`) so it never competes with sounds for another channel; a bot
 * already sitting in that very channel is shared instead (no second bot appears there). A recording bot keeps serving
 * sounds for its own channel but is never moved away.
 */

/** What the hub needs from one bot's voice adapter. DiscordVoiceAdapter satisfies this; tests use fakes. */
export interface SlotVoice extends VoicePort {
  /** Logged in and a member of this guild. */
  canServe(guildId: string): boolean;
  /** The channel this bot is connected to in the guild, or null. */
  channelOf(guildId: string): string | null;
  /** Join (or reuse) the channel, listening enabled, and return the ready connection. */
  connect(guildId: string, channelId: string): Promise<VoiceConnection>;
}

export interface HubSlot {
  id: string;
  /** Shown to people ("Main", "Worker 2"). */
  label: string;
  worker: boolean;
  adapter: SlotVoice;
  /** The bot's account once it is logged in (names, invite links). */
  identity?: () => { id: string; tag: string } | null;
}

export interface RecordingLease {
  slotId: string;
  label: string;
  /** True: this bot was brought in for the recording (and leaves when it ends). False: it was already in the channel. */
  exclusive: boolean;
  connection: VoiceConnection;
}

export type SlotState = "idle" | "playing" | "recording" | "unavailable";

export interface SlotReport {
  id: string;
  label: string;
  worker: boolean;
  tag: string | null;
  userId: string | null;
  /** Is this bot a member of the guild (and logged in)? */
  inGuild: boolean;
  channelId: string | null;
  state: SlotState;
}

export interface VoiceHubOptions {
  /** How long a sound may wait for a free bot before it is given up on. Default 60 s. */
  waitMs?: number;
  recordingPreferredWorker?: string;
}

interface SlotGuild {
  /** Channel a play() is running in right now. */
  playing: string | null;
  lease: { channelId: string; exclusive: boolean } | null;
}

interface Waiter {
  tryNow(): boolean;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_WAIT_MS = 60_000;

export class VoiceHub implements VoicePort {
  #slots: HubSlot[] = [];
  #state = new Map<string, SlotGuild>();
  #waiters = new Map<string, Waiter[]>();
  #waitMs: number;
  #recordingPreferredWorker: string;
  #closed = false;

  constructor(options: VoiceHubOptions = {}) {
    this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.#recordingPreferredWorker = options.recordingPreferredWorker ?? "worker-2";
  }

  /** Slots are tried in the order they were added: add the main bot first so it serves sounds before the workers. */
  addSlot(slot: HubSlot): void {
    this.#slots.push(slot);
  }

  get slotCount(): number {
    return this.#slots.length;
  }

  // ---------- who is doing what (for !voicebots and tests) ----------

  /** True while a recording needs this bot's connection in this guild (the adapter must not tear it down). */
  isLeased(slotId: string, guildId: string): boolean {
    return this.#st(slotId, guildId).lease !== null;
  }

  describe(guildId: string): SlotReport[] {
    return this.#slots.map((s) => {
      const st = this.#st(s.id, guildId);
      const id = s.identity?.() ?? null;
      const inGuild = s.adapter.canServe(guildId);
      return {
        id: s.id,
        label: s.label,
        worker: s.worker,
        tag: id?.tag ?? null,
        userId: id?.id ?? null,
        inGuild,
        channelId: s.adapter.channelOf(guildId),
        state: !inGuild ? "unavailable" : st.lease ? "recording" : st.playing ? "playing" : "idle",
      };
    });
  }

  // ---------- playback (VoicePort) ----------

  async play(guildId: string, channelId: string, filePath: string, maxDurationSec?: number, onStarted?: () => void): Promise<void> {
    const slot = await this.#acquire(guildId, channelId);
    const st = this.#st(slot.id, guildId);
    try {
      await slot.adapter.play(guildId, channelId, filePath, maxDurationSec, onStarted);
    } finally {
      st.playing = null;
      this.#wake(guildId);
    }
  }

  stop(guildId: string, channelId?: string): void {
    for (const s of this.#slots) {
      const playing = this.#st(s.id, guildId).playing;
      if (playing && (channelId === undefined || playing === channelId)) s.adapter.stop(guildId, playing);
    }
  }

  leave(guildId: string, channelId?: string): void {
    for (const s of this.#slots) {
      const st = this.#st(s.id, guildId);
      if (st.playing || st.lease) continue; // busy, or needed by a recording
      if (channelId !== undefined && s.adapter.channelOf(guildId) !== channelId) continue; // that bot is elsewhere now
      s.adapter.leave(guildId, channelId);
    }
  }

  destroyAll(): void {
    this.#closed = true;
    for (const list of this.#waiters.values()) {
      for (const w of list.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error("The bot is shutting down"));
      }
    }
    for (const s of this.#slots) s.adapter.destroyAll();
  }

  // ---------- recording ----------

  /**
   * Gets a bot into `channelId`, listening, for a recording.
   *   1. a bot that is already in that channel is shared (no second bot appears in the channel);
   *   2. otherwise a free bot is dedicated to the recording: workers first, so the main bot stays free for sounds;
   *   3. otherwise it fails: every bot is busy in another channel.
   * Pair every successful call with `releaseRecording`.
   */
  async leaseRecording(guildId: string, channelId: string): Promise<RecordingLease> {
    const usable = this.#slots.filter((s) => s.adapter.canServe(guildId));
    if (!usable.length) throw new Error("No voice bot is available in this server.");

    const st = (s: HubSlot) => this.#st(s.id, guildId);
    const unleased = usable.filter((s) => !st(s).lease);

    let exclusive = false;
    let slot = unleased.find((s) => s.adapter.channelOf(guildId) === channelId);
    if (!slot) {
      exclusive = true;
      const idle = unleased.filter((s) => !st(s).playing);
      slot =
        idle.find((s) => s.worker && s.adapter.channelOf(guildId) === null) ??
        idle.find((s) => s.adapter.channelOf(guildId) === null) ??
        idle[0]; // idle but parked in another channel: it will be moved
    }
    if (!slot) {
      throw new Error(
        usable.length > 1
          ? "Every voice bot in this server is busy in another channel right now."
          : "The only voice bot in this server is busy in another channel. Add voice worker bots to record and play sounds at the same time.",
      );
    }

    // Claim before the first await: two simultaneous starts must not pick the same bot.
    const mine = slot;
    st(mine).lease = { channelId, exclusive };
    try {
      const connection = await mine.adapter.connect(guildId, channelId);
      return { slotId: mine.id, label: mine.label, exclusive, connection };
    } catch (err) {
      st(mine).lease = null;
      this.#wake(guildId);
      throw err;
    }
  }

  /** The recording in this channel is finished and fully saved: give its bot back. */
  releaseRecording(guildId: string, channelId: string, slotId?: string): void {
    for (const s of this.#slots) {
      const st = this.#st(s.id, guildId);
      if (st.lease?.channelId !== channelId || (slotId !== undefined && s.id !== slotId)) continue;
      st.lease = null;
      // Nothing else needs this bot: let it go (a sound still playing keeps it until the queue's own idle leave).
      if (!st.playing) s.adapter.leave(guildId);
    }
    this.#wake(guildId);
  }

  // ---------- internals ----------

  #st(slotId: string, guildId: string): SlotGuild {
    const key = `${slotId}|${guildId}`;
    let st = this.#state.get(key);
    if (!st) this.#state.set(key, (st = { playing: null, lease: null }));
    return st;
  }

  /** A bot that can play in this channel now, null if we have to wait, throws if there never will be one. */
  #pick(guildId: string, channelId: string): HubSlot | null {
    const usable = this.#slots.filter((s) => s.adapter.canServe(guildId));
    if (!usable.length) throw new Error("No voice bot is available in this server.");

    // Someone is already playing in this very channel: wait for that bot instead of calling a second one in.
    if (usable.some((s) => this.#st(s.id, guildId).playing === channelId)) return null;

    const free = usable.filter((s) => {
      const st = this.#st(s.id, guildId);
      if (st.playing) return false;
      // A bot that is recording stays where it is: it may play sounds for ITS channel (it never hears itself, so the
      // recording is unaffected) but is never moved to another channel.
      if (st.lease) return st.lease.channelId === channelId;
      return true;
    });

    return (
      free.find((s) => s.adapter.channelOf(guildId) === channelId) ?? // already there
      free.find((s) => s.adapter.channelOf(guildId) === null) ?? // not connected anywhere in this server
      free[0] ?? // idle in another channel: moved
      null
    );
  }

  #acquire(guildId: string, channelId: string): Promise<HubSlot> {
    return new Promise<HubSlot>((resolve, reject) => {
      if (this.#closed) return reject(new Error("The bot is shutting down"));

      const tryNow = (): boolean => {
        let slot: HubSlot | null;
        try {
          slot = this.#pick(guildId, channelId);
        } catch (err) {
          reject(err as Error);
          return true;
        }
        if (!slot) return false;
        this.#st(slot.id, guildId).playing = channelId; // claimed synchronously
        resolve(slot);
        return true;
      };

      if (tryNow()) return;

      const list = this.#waiters.get(guildId) ?? [];
      this.#waiters.set(guildId, list);
      const waiter: Waiter = {
        tryNow,
        reject,
        timer: setTimeout(() => {
          const i = list.indexOf(waiter);
          if (i !== -1) list.splice(i, 1);
          reject(new Error("All voice bots in this server stayed busy; the sound was skipped."));
        }, this.#waitMs),
      };
      list.push(waiter);
    });
  }

  /** A bot was freed: let the sounds that were waiting try again, oldest first. */
  #wake(guildId: string): void {
    const list = this.#waiters.get(guildId);
    if (!list?.length) return;
    for (const w of [...list]) {
      if (!w.tryNow()) continue;
      clearTimeout(w.timer);
      list.splice(list.indexOf(w), 1);
    }
  }
}
