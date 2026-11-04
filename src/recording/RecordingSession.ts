import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import type { Readable } from "node:stream";
import { OggOpusWriter } from "./OggOpusWriter.ts";
import type { ChannelParticipant, ParticipantTrack, RecordingManifest, RecordingState, RecordingType, SoundTrack } from "./recordingTypes.ts";

/** Optional human-readable names, written into the manifest so the recordings page can search by name. */
export interface RecordingMeta {
  guildName?: string;
  channelName?: string;
  initiatedByName?: string;
  /** Looked up when a speaker's segment starts. */
  resolveUserName?(userId: string): string | null | undefined;
  /** Entrance recordings only (leave all of these out for `!record start` / follow sessions). */
  type?: RecordingType;
  entrant?: { userId: string; username?: string };
  soundName?: string;
  channelParticipants?: ChannelParticipant[];
  reactionTailMs?: number;
  /** Also pick up people who are already in the middle of speaking when the session starts. */
  catchUpSpeakers?: boolean;
}

/** The entrance sound's file; it sits next to the participant tracks so the existing scan, player and export see it. */
const SOUND_FILE = "participants/entrance_sound.ogg";

/** A speaker is cut into a new file after this much silence. */
const SILENCE_MS = 1500;

/** How long finalize waits for one file to flush before giving up on it. */
const FLUSH_TIMEOUT_MS = 5000;

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/** One speech segment: Opus packets from Discord -> Ogg writer -> file. */
interface Track {
  src: Readable;
  ogg: OggOpusWriter;
  out: WriteStream;
  onData: (packet: Buffer) => void;
  /**
   * False when another session on the same connection had already subscribed to this speaker: the library hands both
   * the same receive stream, so only the session that created it may destroy it.
   */
  owned: boolean;
}

/** The outgoing sound: Opus packets the player sends -> Ogg writer -> file. */
interface SoundState {
  ogg: OggOpusWriter;
  out: WriteStream;
}

export class RecordingSession {
  readonly sessionId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly initiatedBy: string;
  readonly startedAt = new Date();
  endedAt?: Date;
  status: RecordingState = "IDLE";

  readonly #connection: VoiceConnection;
  readonly #dir: string;
  readonly #tracks: ParticipantTrack[] = [];
  readonly #open = new Set<Track>();
  #finalizing: Promise<void> | null = null;
  readonly #speaking = new Set<string>();
  readonly #segment = new Map<string, number>();
  #listener: ((userId: string) => void) | null = null;
  #ready = false;
  #sound: SoundState | null = null;
  #soundBacklog: Buffer[] = [];
  #soundFirstAt: Date | null = null;
  #soundEndedAt: Date | null = null;

  readonly #meta: RecordingMeta;

  constructor(guildId: string, channelId: string, initiatedBy: string, connection: VoiceConnection, baseDir: string, meta: RecordingMeta = {}) {
    this.#meta = meta;
    this.guildId = guildId;
    this.channelId = channelId;
    this.initiatedBy = initiatedBy;
    this.#connection = connection;

    const d = this.startedAt;
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    this.sessionId = `${stamp}_${randomBytes(3).toString("hex")}`;
    this.#dir = join(baseDir, "guilds", guildId, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), this.sessionId);
  }

  get sessionDir(): string {
    return this.#dir;
  }

  get durationSeconds(): number {
    const end = this.endedAt ?? new Date();
    return Math.round((end.getTime() - this.startedAt.getTime()) / 1000);
  }

  /** Creates the folder, writes the first manifest, and starts listening to speakers. */
  async start(): Promise<void> {
    this.status = "CONNECTING";
    await mkdir(join(this.#dir, "participants"), { recursive: true });
    await this.#writeManifest("active");

    this.#listener = (userId) => this.#onSpeakingStart(userId);
    this.#connection.receiver.speaking.on("start", this.#listener);
    this.status = "ACTIVE";
    this.#ready = true;

    // Sound packets that arrived while the folder was still being created.
    for (const packet of this.#soundBacklog.splice(0)) this.#sinkSound(packet);
    if (this.#soundEndedAt) this.#sound?.ogg.end();

    if (this.#meta.catchUpSpeakers) {
      for (const userId of [...this.#connection.receiver.speaking.users.keys()]) this.#onSpeakingStart(userId);
    }
  }

  /** Entrance recordings: one packet of the sound the player is sending right now. Never throws. */
  writeSoundPacket(packet: Buffer): void {
    if (this.#soundEndedAt || this.status === "FINALISING" || this.status === "SAVED" || this.status === "INTERRUPTED") return;
    this.#soundFirstAt ??= new Date();
    if (!this.#ready) {
      if (this.#soundBacklog.length < 1000) this.#soundBacklog.push(Buffer.from(packet));
      return;
    }
    this.#sinkSound(packet);
  }

  /** Playback finished: close the sound track (the participant tracks keep recording). Safe to call twice. */
  endSound(): void {
    if (this.#soundEndedAt) return;
    this.#soundEndedAt = new Date();
    if (this.#sound && !this.#sound.ogg.writableEnded) this.#sound.ogg.end();
  }

  /** The file is created with the first packet, so a sound that never played leaves no empty track behind. */
  #sinkSound(packet: Buffer): void {
    if (!this.#sound) {
      const ogg = new OggOpusWriter();
      const out = createWriteStream(join(this.#dir, SOUND_FILE));
      const log = (what: string) => (err: Error) => console.error(`Recording ${this.sessionId}: sound ${what} failed:`, err.message);
      ogg.on("error", log("writer"));
      out.on("error", log("file"));
      ogg.pipe(out);
      this.#sound = { ogg, out };
    }
    if (!this.#sound.ogg.writableEnded) this.#sound.ogg.write(packet);
  }

  #onSpeakingStart(userId: string): void {
    if (this.status !== "ACTIVE" || this.#speaking.has(userId)) return;
    this.#speaking.add(userId);

    const n = (this.#segment.get(userId) ?? 0) + 1;
    this.#segment.set(userId, n);
    const file = `participants/${userId}_${n}.ogg`;
    let username: string | undefined;
    try {
      username = this.#meta.resolveUserName?.(userId) || undefined;
    } catch {
      // a failed name lookup must never cost us the audio
    }
    this.#tracks.push({ userId, file, startedAt: new Date().toISOString(), ...(username ? { username } : {}) });

    const owned = !this.#connection.receiver.subscriptions.has(userId);
    const src = this.#connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const ogg = new OggOpusWriter();
    const out = createWriteStream(join(this.#dir, file));
    const track: Track = { src, ogg, out, owned, onData: (packet) => ogg.write(packet) };
    this.#open.add(track);

    const log = (what: string) => (err: Error) => console.error(`Recording ${this.sessionId}: ${what} for ${userId} failed:`, err.message);
    src.on("error", log("receive stream"));
    ogg.on("error", log("writer"));
    out.on("error", log("file"));

    ogg.pipe(out);
    src.on("data", track.onData);
    // @discordjs/voice DESTROYS the receive stream when it ends (silence timeout, connection closing, or our own
    // finalize). That is the one normal end: always finish the Ogg stream and the file from here, never abort them.
    src.once("close", () => this.#endTrack(track));
    out.once("close", () => {
      this.#open.delete(track);
      this.#speaking.delete(userId);
    });
  }

  /** Stops feeding the writer and lets it flush its last packet, the end-of-stream page, and the file. Safe to call twice. */
  #endTrack(track: Track): void {
    track.src.off("data", track.onData);
    if (!track.ogg.writableEnded) track.ogg.end();
  }

  /**
   * Stops listening, flushes every speaker's file completely, then writes the final manifest.
   * Resolves only when all data is on disk, so callers may release the voice connection right after.
   * Calling it again returns the same promise.
   */
  finalize(status: "SAVED" | "INTERRUPTED" = "SAVED"): Promise<void> {
    return (this.#finalizing ??= this.#finalize(status));
  }

  async #finalize(status: "SAVED" | "INTERRUPTED"): Promise<void> {
    this.status = "FINALISING";
    if (this.#listener) this.#connection.receiver.speaking.off("start", this.#listener);
    this.#listener = null;
    this.endedAt = new Date();

    const tracks = [...this.#open];
    this.endSound();
    const closed = (out: WriteStream) =>
      new Promise<void>((resolve) => {
        if (out.closed) return resolve();
        const timer = setTimeout(() => {
          console.error(`Recording ${this.sessionId}: a file did not finish flushing in ${FLUSH_TIMEOUT_MS} ms`);
          resolve();
        }, FLUSH_TIMEOUT_MS);
        out.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    const flushed = tracks.map(({ out }) => closed(out));
    if (this.#sound) flushed.push(closed(this.#sound.out));

    for (const track of tracks) {
      // Pull out whatever the receive stream still holds, finish the Ogg stream, and only then let go of the source.
      // (Never push(null) on it: the library destroys the stream on the next tick and drops unread packets.)
      // (read() emits "data" itself, so the normal handler writes each packet; do not write them again here.)
      while (track.src.read() !== null);
      this.#endTrack(track);
      // A receive stream shared with another session (e.g. a manual recording in the same channel) is theirs too:
      // destroying it would cut their segment short. Only the session that created it ends it.
      if (track.owned) track.src.destroy();
    }
    await Promise.all(flushed);

    this.status = status;
    await this.#writeManifest(status === "SAVED" ? "completed" : "interrupted");
  }

  async #writeManifest(manifestStatus: RecordingManifest["status"]): Promise<void> {
    const manifest: RecordingManifest = {
      sessionId: this.sessionId,
      guildId: this.guildId,
      channelId: this.channelId,
      initiatedBy: this.initiatedBy,
      ...(this.#meta.guildName ? { guildName: this.#meta.guildName } : {}),
      ...(this.#meta.channelName ? { channelName: this.#meta.channelName } : {}),
      ...(this.#meta.initiatedByName ? { initiatedByName: this.#meta.initiatedByName } : {}),
      startedAt: this.startedAt.toISOString(),
      endedAt: this.endedAt?.toISOString(),
      durationSeconds: this.durationSeconds,
      status: manifestStatus,
      format: "ogg-opus",
      ...(this.#meta.type === "entrance"
        ? {
            type: "entrance" as const,
            ...(this.#meta.entrant ? { entrant: this.#meta.entrant } : {}),
            ...(this.#meta.soundName ? { soundName: this.#meta.soundName } : {}),
            ...(this.#meta.channelParticipants ? { channelParticipants: this.#meta.channelParticipants } : {}),
            ...(this.#meta.reactionTailMs !== undefined ? { reactionTailMs: this.#meta.reactionTailMs } : {}),
          }
        : {}),
      outputs: { participants: [...this.#tracks], ...(this.#sound ? { sound: this.#soundTrack() } : {}) },
    };
    await writeFile(join(this.#dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  }

  #soundTrack(): SoundTrack {
    return {
      file: SOUND_FILE,
      name: this.#meta.soundName ?? "sound",
      startedAt: (this.#soundFirstAt ?? this.startedAt).toISOString(),
      ...(this.#soundEndedAt ? { endedAt: this.#soundEndedAt.toISOString() } : {}),
    };
  }
}
