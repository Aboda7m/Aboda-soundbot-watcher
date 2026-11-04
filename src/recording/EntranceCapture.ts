import { VoiceConnectionStatus, type AudioResource, type VoiceConnection } from "@discordjs/voice";
import { recordingManager } from "./RecordingManager.ts";
import { RecordingSession } from "./RecordingSession.ts";
import type { ChannelParticipant } from "./recordingTypes.ts";

/**
 * Automatic entrance-reaction recording.
 *
 * Runs on the bot that plays the entrance sound, over that bot's own voice connection: nothing here joins a channel,
 * asks the hub for a bot, or touches worker allocation. It is deliberately NOT registered in RecordingManager, which
 * allows one session per guild: a manual or follow recording (e.g. on Worker 2) can run at the same time, and no
 * "recording started" alert or chat message is produced for it.
 *
 * Environment (read when an entrance is played, so no restart-time wiring is needed):
 *   ENTRANCE_RECORDING_ENABLED   "1"/"true"/"yes"/"on" turns it on. Default: off.
 *   ENTRANCE_RECORDING_TAIL_MS   reaction time kept after the sound ends. Default 2000, 0..30000.
 */
export interface EntranceRecordingConfig {
  enabled: boolean;
  tailMs: number;
}

export const DEFAULT_TAIL_MS = 2000;
const MAX_TAIL_MS = 30_000;

export function entranceRecordingConfig(env: NodeJS.ProcessEnv = process.env): EntranceRecordingConfig {
  const enabled = /^(?:1|true|yes|on)$/i.test((env.ENTRANCE_RECORDING_ENABLED ?? "").trim());
  const raw = Number((env.ENTRANCE_RECORDING_TAIL_MS ?? "").trim());
  const tailMs = env.ENTRANCE_RECORDING_TAIL_MS?.trim() && Number.isFinite(raw) && raw >= 0 ? Math.min(MAX_TAIL_MS, Math.round(raw)) : DEFAULT_TAIL_MS;
  return { enabled, tailMs };
}

export interface EntranceCaptureInput {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  soundName: string;
  /** Used as `initiatedBy` when the entrant is unknown (the bot that is playing). */
  botUserId: string;
  entrant?: { userId: string; username?: string };
  guildName?: string;
  channelName?: string;
  channelParticipants: ChannelParticipant[];
  resolveUserName?(userId: string): string | null | undefined;
  tailMs: number;
  log?(message: string, err?: unknown): void;
}

export class EntranceCapture {
  readonly #in: EntranceCaptureInput;
  #session: RecordingSession | null = null;
  #starting: Promise<void> | null = null;
  #started = false;
  #playbackEndedAt: number | null = null;
  #cancelTail: (() => void) | null = null;
  #tailCancelled = false;

  constructor(input: EntranceCaptureInput) {
    this.#in = input;
  }

  /**
   * Makes every Opus packet the player takes from `resource` also go to the sound track: the recorded sound is exactly
   * what was sent to the channel, with the same timing. Call before `player.play(resource)`. Packets are ignored
   * until `begin()`. Never throws into the player.
   */
  tap(resource: AudioResource): void {
    const read = resource.read.bind(resource);
    resource.read = () => {
      const packet = read();
      if (packet && this.#session && this.#playbackEndedAt === null) {
        try {
          this.#session.writeSoundPacket(packet);
        } catch {
          // a recording problem must never cost the sound
        }
      }
      return packet;
    };
  }

  /** Playback is audible now: start capturing the participants and the sound. Never throws. */
  begin(): void {
    if (this.#session) return;
    const i = this.#in;
    try {
      const session = new RecordingSession(i.guildId, i.channelId, i.entrant?.userId ?? i.botUserId, i.connection, recordingManager.baseDir, {
        ...(i.guildName ? { guildName: i.guildName } : {}),
        ...(i.channelName ? { channelName: i.channelName } : {}),
        ...(i.entrant?.username ? { initiatedByName: i.entrant.username } : {}),
        ...(i.resolveUserName ? { resolveUserName: i.resolveUserName } : {}),
        type: "entrance",
        ...(i.entrant ? { entrant: i.entrant } : {}),
        soundName: i.soundName,
        channelParticipants: i.channelParticipants,
        reactionTailMs: i.tailMs,
        catchUpSpeakers: true,
      });
      this.#session = session;
      this.#starting = session.start().then(
        () => {
          this.#started = true;
        },
        (err) => {
          this.#session = null; // nothing usable: stop feeding it
          i.log?.(`Entrance recording for "${i.soundName}" in guild ${i.guildId} could not start`, err);
        },
      );
    } catch (err) {
      this.#session = null;
      i.log?.(`Entrance recording for "${i.soundName}" in guild ${i.guildId} could not start`, err);
    }
  }

  /** The player went idle: the sound is over. Closes the sound track; the participants keep recording for the tail. */
  playbackEnded(): void {
    if (this.#playbackEndedAt !== null) return;
    this.#playbackEndedAt = Date.now();
    try {
      this.#session?.endSound();
    } catch {
      // ignored: see tap()
    }
  }

  /** Shutdown: do not wait out the tail, finish saving now. */
  cancelTail(): void {
    this.#tailCancelled = true;
    this.#cancelTail?.();
  }

  /**
   * Waits out whatever is left of the reaction tail (counted from the moment playback ended), then saves everything.
   * `failed`: playback broke down, so there is no tail and the recording is marked interrupted. Never throws.
   */
  async finish(failed = false): Promise<void> {
    try {
      this.playbackEnded();
      await this.#starting;
      const session = this.#session;
      if (!session || !this.#started) return;

      if (!failed && !this.#tailCancelled) {
        const left = this.#in.tailMs - (Date.now() - (this.#playbackEndedAt ?? Date.now()));
        if (left > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, left);
            timer.unref();
            this.#cancelTail = () => {
              clearTimeout(timer);
              resolve();
            };
            if (this.#tailCancelled) this.#cancelTail();
          });
          this.#cancelTail = null;
        }
      }

      const connectionLost = this.#in.connection.state.status === VoiceConnectionStatus.Destroyed;
      await session.finalize(failed || connectionLost ? "INTERRUPTED" : "SAVED");
    } catch (err) {
      this.#in.log?.(`Entrance recording for "${this.#in.soundName}" in guild ${this.#in.guildId} could not be saved`, err);
    }
  }
}
