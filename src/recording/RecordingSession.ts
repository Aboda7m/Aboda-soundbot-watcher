import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import type { Readable } from "node:stream";
import { OggOpusWriter } from "./OggOpusWriter.ts";
import type { ParticipantTrack, RecordingManifest, RecordingState } from "./recordingTypes.ts";

/** A speaker is cut into a new file after this much silence. */
const SILENCE_MS = 1500;

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

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
  readonly #open = new Map<WriteStream, Readable>(); // file -> its opus source
  readonly #speaking = new Set<string>();
  readonly #segment = new Map<string, number>();
  #listener: ((userId: string) => void) | null = null;

  constructor(guildId: string, channelId: string, initiatedBy: string, connection: VoiceConnection, baseDir: string) {
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
  }

  #onSpeakingStart(userId: string): void {
    if (this.status !== "ACTIVE" || this.#speaking.has(userId)) return;
    this.#speaking.add(userId);

    const n = (this.#segment.get(userId) ?? 0) + 1;
    this.#segment.set(userId, n);
    const file = `participants/${userId}_${n}.ogg`;
    this.#tracks.push({ userId, file, startedAt: new Date().toISOString() });

    const opusStream = this.#connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const ogg = new OggOpusWriter();
    const out = createWriteStream(join(this.#dir, file));
    this.#open.set(out, opusStream);

    pipeline(opusStream, ogg, out, (err) => {
      this.#open.delete(out);
      this.#speaking.delete(userId);
      if (err && this.status === "ACTIVE") console.error(`Recording ${this.sessionId}: stream for ${userId} failed:`, err.message);
    });
  }

  /** Stops listening, waits for every file to be flushed, writes the final manifest. */
  async finalize(status: "SAVED" | "INTERRUPTED" = "SAVED"): Promise<void> {
    if (this.status === "FINALISING" || this.status === "SAVED" || this.status === "INTERRUPTED") return;
    this.status = "FINALISING";
    if (this.#listener) this.#connection.receiver.speaking.off("start", this.#listener);
    this.#listener = null;
    this.endedAt = new Date();

    // End every open speaker stream gracefully: the Ogg writer then writes its end-of-stream page and the file closes.
    const closing = [...this.#open].map(
      ([file, src]) =>
        new Promise<void>((resolve) => {
          if (file.closed) return resolve();
          const t = setTimeout(resolve, 5000);
          file.once("close", () => {
            clearTimeout(t);
            resolve();
          });
          src.push(null);
        }),
    );
    await Promise.all(closing);

    this.status = status;
    await this.#writeManifest(status === "SAVED" ? "completed" : "interrupted");
  }

  async #writeManifest(manifestStatus: RecordingManifest["status"]): Promise<void> {
    const manifest: RecordingManifest = {
      sessionId: this.sessionId,
      guildId: this.guildId,
      channelId: this.channelId,
      initiatedBy: this.initiatedBy,
      startedAt: this.startedAt.toISOString(),
      endedAt: this.endedAt?.toISOString(),
      durationSeconds: this.durationSeconds,
      status: manifestStatus,
      format: "ogg-opus",
      outputs: { participants: [...this.#tracks] },
    };
    await writeFile(join(this.#dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  }
}
