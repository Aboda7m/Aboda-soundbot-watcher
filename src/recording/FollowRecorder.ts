import type { VoiceConnection } from "@discordjs/voice";
import type { RecordingLease, VoiceHub } from "../voice/VoiceHub.ts";
import type { RecordingManager } from "./RecordingManager.ts";
import type { RecordingSession } from "./RecordingSession.ts";

/**
 * `!record attach @user` / `!record detach`: record the voice channel a chosen user is in, wherever they go.
 *
 *   - target joins voice      -> a recording starts in their channel
 *   - target moves channel    -> the current session is saved and a new one starts in the new channel
 *   - target leaves voice     -> the session is saved; the registration stays
 *   - target comes back       -> a new session starts
 *   - the bot loses its voice connection -> the session is saved as interrupted; the registration stays
 *   - detach                  -> the session is saved and the registration is removed
 *
 * It reuses the normal pipeline (VoiceHub lease -> RecordingManager/RecordingSession -> same folder and manifest
 * format) but with a RecordingManager of its own, so a manual `!record start` and a follow never share a session
 * slot. Only this file knows about following; it imports Discord types only, so it is testable with plain fakes.
 *
 * All work for one guild runs one task at a time (`#run`), so quick moves, a detach during a start, or a connection
 * loss during a move can never overlap. Registrations live in memory: they are gone after a restart.
 */

/** What the recorder needs to name things and talk back, captured when `!record attach` runs. */
export interface FollowContext {
  guildName?: string;
  initiatedByName?: string;
  /** Written into the manifest of each session. */
  channelName?(channelId: string): string | undefined;
  /** Looked up when a speaker's segment starts (same hook as a manual recording). */
  resolveUserName?(userId: string): string | null | undefined;
  /** Where automatic notices go (the text channel `attach` ran in). Failures are logged, never thrown. */
  notify?(text: string): Promise<unknown> | void;
}

export interface FollowRecorderOptions {
  voiceHub: Pick<VoiceHub, "leaseRecording" | "releaseRecording">;
  /** Give it its OWN RecordingManager (same base directory) so follow sessions stay apart from manual ones. */
  manager: Pick<RecordingManager, "startSession" | "stopSession">;
  /** Calls `onLost` when the connection is destroyed or fails to reconnect. May be called more than once. */
  watchConnection?: (connection: VoiceConnection, onLost: () => void) => void;
  log?: (message: string, err?: unknown) => void;
}

export interface FollowVoiceEvent {
  guildId: string;
  userId: string;
  /** The recordable voice channel the user is in now; null when they are not in one. */
  channelId: string | null;
}

export interface FollowInfo {
  targetId: string;
  initiatedBy: string;
  /** The running session, or null while the target is not in voice (or a start failed). */
  session: RecordingSession | null;
}

export type AttachResult =
  | { ok: true; already: boolean; session: RecordingSession | null; error?: string }
  | { ok: false; reason: "other-target"; targetId: string };

export type DetachResult = { ok: false } | { ok: true; targetId: string; session: RecordingSession | null };

interface Follow {
  readonly guildId: string;
  readonly targetId: string;
  readonly initiatedBy: string;
  context: FollowContext;
  /** Where the target is right now (null: not in a recordable voice channel). Always the latest known value. */
  desired: string | null;
  session: RecordingSession | null;
  lease: RecordingLease | null;
  detached: boolean;
  /** Tail of the guild's task queue. */
  chain: Promise<unknown>;
  /** The last start failure we told people about, so a failing retry does not repeat itself. */
  lastError: string | null;
}

interface ReconcileResult {
  stopped?: RecordingSession | undefined;
  started?: RecordingSession | undefined;
  error?: string | undefined;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class FollowRecorder {
  readonly #opts: FollowRecorderOptions;
  readonly #follows = new Map<string, Follow>();
  /** A detach that is still saving: a new attach waits for it so it cannot fight for the same bot. */
  readonly #closing = new Map<string, Promise<void>>();

  constructor(options: FollowRecorderOptions) {
    this.#opts = options;
  }

  get(guildId: string): FollowInfo | undefined {
    const f = this.#follows.get(guildId);
    return f && { targetId: f.targetId, initiatedBy: f.initiatedBy, session: f.session };
  }

  /**
   * Registers the follow (one per guild) and, when the target is already in voice, starts recording right away.
   * Attaching the same user again is harmless and retries a failed start.
   */
  async attach(opts: {
    guildId: string;
    targetId: string;
    initiatedBy: string;
    /** The target's current recordable voice channel, null when they are not in one. */
    targetChannelId: string | null;
    context: FollowContext;
  }): Promise<AttachResult> {
    await this.#closing.get(opts.guildId);

    const existing = this.#follows.get(opts.guildId);
    if (existing) {
      if (existing.targetId !== opts.targetId) return { ok: false, reason: "other-target", targetId: existing.targetId };
      existing.context = opts.context;
      existing.desired = opts.targetChannelId;
      const r = await this.#run(existing, () => this.#reconcile(existing));
      existing.lastError = r.error ?? null;
      return { ok: true, already: true, session: existing.session, ...(r.error ? { error: r.error } : {}) };
    }

    const f: Follow = {
      guildId: opts.guildId,
      targetId: opts.targetId,
      initiatedBy: opts.initiatedBy,
      context: opts.context,
      desired: opts.targetChannelId,
      session: null,
      lease: null,
      detached: false,
      chain: Promise.resolve(),
      lastError: null,
    };
    this.#follows.set(opts.guildId, f);
    const r = await this.#run(f, () => this.#reconcile(f));
    f.lastError = r.error ?? null;
    return { ok: true, already: false, session: f.session, ...(r.error ? { error: r.error } : {}) };
  }

  /** Saves the running session (if any) and forgets the follow. Resolves once everything is on disk. */
  async detach(guildId: string): Promise<DetachResult> {
    const f = this.#follows.get(guildId);
    if (!f) return { ok: false };
    this.#follows.delete(guildId);
    f.detached = true; // an in-flight start notices this and stops looping; the task below then cleans up after it

    const closing = this.#run(f, async () => {
      const session = f.session;
      await this.#stopCurrent(f, false);
      return session;
    });
    const done = closing.then(
      () => {},
      () => {},
    );
    this.#closing.set(guildId, done);
    try {
      return { ok: true, targetId: f.targetId, session: await closing };
    } finally {
      if (this.#closing.get(guildId) === done) this.#closing.delete(guildId);
    }
  }

  /** Feed every voice state change here; only the followed user in a followed guild does anything. Never rejects. */
  onVoiceMove(event: FollowVoiceEvent): Promise<void> {
    const f = this.#follows.get(event.guildId);
    if (!f || f.detached || f.targetId !== event.userId) return Promise.resolve();
    f.desired = event.channelId; // synchronously, so a burst of moves collapses into the last one

    return this.#run(f, async () => {
      try {
        await this.#announce(f, await this.#reconcile(f));
      } catch (err) {
        this.#log(`Follow recording for ${f.targetId} failed`, err);
      }
    });
  }

  /** Bot shutdown: saves every running session as interrupted and drops all registrations. */
  async shutdown(): Promise<void> {
    const all = [...this.#follows.values()];
    this.#follows.clear();
    await Promise.allSettled(
      all.map((f) => {
        f.detached = true;
        return this.#run(f, () => this.#stopCurrent(f, true));
      }),
    );
  }

  // ---------- internals ----------

  #log(message: string, err?: unknown): void {
    (this.#opts.log ?? ((m, e) => console.error(m, e instanceof Error ? `: ${e.message}` : (e ?? ""))))(message, err);
  }

  /** Runs `task` after everything queued before it for this guild. The queue survives a failing task. */
  #run<T>(f: Follow, task: () => Promise<T>): Promise<T> {
    const p = f.chain.then(task);
    f.chain = p.catch(() => {});
    return p;
  }

  /** Brings the recording in line with where the target is now, and reports what changed. */
  async #reconcile(f: Follow): Promise<ReconcileResult> {
    const before = f.session;
    const error = await this.#converge(f);
    const after = f.session;
    return {
      stopped: before && before !== after ? before : undefined,
      started: after && after !== before ? after : undefined,
      error,
    };
  }

  /**
   * Loops until the session matches `desired`. `desired` is re-read after every await, so a move that happens
   * while we are stopping or starting is picked up instead of being lost. A failed start ends the loop: the next
   * voice event of the target retries.
   */
  async #converge(f: Follow): Promise<string | undefined> {
    for (;;) {
      if (f.detached) return undefined;
      const want = f.desired;
      if (f.session) {
        if (f.session.channelId === want) return undefined;
        await this.#stopCurrent(f, false); // left voice, or moved to another channel
        continue;
      }
      if (want === null) return undefined;
      const started = await this.#start(f, want);
      if (typeof started === "string") return started;
    }
  }

  /** Leases a bot and starts a session. Returns the session, or the reason it could not start (nothing is left held). */
  async #start(f: Follow, channelId: string): Promise<RecordingSession | string> {
    const { voiceHub, manager, watchConnection } = this.#opts;
    let lease: RecordingLease;
    try {
      lease = await voiceHub.leaseRecording(f.guildId, channelId);
    } catch (err) {
      return `Could not allocate a recording bot: ${errorText(err)}`;
    }

    const release = () => {
      try {
        voiceHub.releaseRecording(f.guildId, channelId, lease.slotId);
      } catch (err) {
        this.#log("Follow recording could not release its bot", err);
      }
    };

    let session: RecordingSession | null;
    try {
      const { guildName, initiatedByName, channelName, resolveUserName } = f.context;
      const name = channelName?.(channelId);
      session = await manager.startSession(f.guildId, channelId, f.initiatedBy, lease.connection, {
        ...(guildName ? { guildName } : {}),
        ...(name ? { channelName: name } : {}),
        ...(initiatedByName ? { initiatedByName } : {}),
        ...(resolveUserName ? { resolveUserName: (id: string) => resolveUserName(id) } : {}),
      });
    } catch (err) {
      this.#log(`Follow recording could not start in ${channelId}`, err);
      release();
      return `Could not start recording: ${errorText(err)}`;
    }
    if (!session) {
      release();
      return "A follow recording is already active in this server.";
    }

    f.session = session;
    f.lease = lease;
    f.lastError = null;
    const started = session;
    watchConnection?.(lease.connection, () => this.#lost(f, started));
    return session;
  }

  /**
   * Finalizes the running session and gives its bot back, in that order (the files must be flushed before the
   * connection goes). State is cleared first, so a connection-lost callback fired by the release is a no-op.
   */
  async #stopCurrent(f: Follow, interrupted: boolean): Promise<void> {
    const { session, lease } = f;
    if (!session) return;
    f.session = null;
    f.lease = null;
    try {
      await this.#opts.manager.stopSession(f.guildId, interrupted);
    } catch (err) {
      this.#log(`Follow recording ${session.sessionId} could not be finalized cleanly`, err);
    } finally {
      if (lease) {
        try {
          this.#opts.voiceHub.releaseRecording(f.guildId, session.channelId, lease.slotId);
        } catch (err) {
          this.#log("Follow recording could not release its bot", err);
        }
      }
    }
  }

  /** The bot's connection died under a running session: save it as interrupted, keep following. */
  #lost(f: Follow, session: RecordingSession): void {
    void this.#run(f, async () => {
      if (f.session !== session) return; // already stopped (moved, left, detached) or reported
      await this.#stopCurrent(f, true);
      await this.#notify(
        f,
        `⚠️ Recording \`${session.sessionId}\` was interrupted (disconnected). What was captured is saved. Still following <@${f.targetId}>; recording resumes when they next move or rejoin voice.`,
      );
    });
  }

  async #announce(f: Follow, r: ReconcileResult): Promise<void> {
    const who = `<@${f.targetId}>`;
    const lines: string[] = [];
    if (r.stopped && r.started) {
      lines.push(`🔀 ${who} moved to <#${r.started.channelId}>. Saved \`${r.stopped.sessionId}\`; new session \`${r.started.sessionId}\`.`);
    } else if (r.stopped) {
      lines.push(
        f.desired === null
          ? `⏹️ ${who} left voice. Saved \`${r.stopped.sessionId}\` (${r.stopped.durationSeconds}s). Still following; recording resumes when they rejoin.`
          : `⏹️ ${who} changed channel. Saved \`${r.stopped.sessionId}\` (${r.stopped.durationSeconds}s).`,
      );
    } else if (r.started) {
      lines.push(`🔴 Recording ${who} in <#${r.started.channelId}>.\nSession: \`${r.started.sessionId}\``);
    }
    if (r.error && r.error !== f.lastError) {
      lines.push(`⚠️ Could not record ${who}${f.desired ? ` in <#${f.desired}>` : ""}: ${r.error}\nStill following; it retries on their next voice update.`);
    }
    f.lastError = r.error ?? null;
    if (lines.length) await this.#notify(f, lines.join("\n"));
  }

  async #notify(f: Follow, text: string): Promise<void> {
    try {
      await f.context.notify?.(text);
    } catch (err) {
      this.#log("Follow notice could not be sent", err);
    }
  }
}
