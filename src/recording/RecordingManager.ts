import { join } from "node:path";
import type { VoiceConnection } from "@discordjs/voice";
import { RecordingSession } from "./RecordingSession.ts";

export class RecordingManager {
  readonly #sessions = new Map<string, RecordingSession>();
  readonly #baseDir: string;

  constructor(baseDir: string = join(process.cwd(), "recordings")) {
    this.#baseDir = baseDir;
  }

  /** Starts a session, or returns null when this guild is already recording. */
  async startSession(guildId: string, channelId: string, userId: string, connection: VoiceConnection): Promise<RecordingSession | null> {
    if (this.#sessions.has(guildId)) return null;

    const session = new RecordingSession(guildId, channelId, userId, connection, this.#baseDir);
    this.#sessions.set(guildId, session); // reserve first so a double "start" cannot race
    try {
      await session.start();
    } catch (err) {
      this.#sessions.delete(guildId);
      throw err;
    }
    return session;
  }

  /**
   * Finalizes the guild's session. The session stays registered until it is completely flushed, so nothing
   * else (a second start, the voice adapter's idle leave) treats the guild as free while data is still being written.
   * `interrupted` marks it as cut short (e.g. bot disconnected).
   */
  async stopSession(guildId: string, interrupted = false): Promise<RecordingSession | null> {
    const session = this.#sessions.get(guildId);
    if (!session) return null;
    try {
      await session.finalize(interrupted ? "INTERRUPTED" : "SAVED");
    } finally {
      if (this.#sessions.get(guildId) === session) this.#sessions.delete(guildId);
    }
    return session;
  }

  getSession(guildId: string): RecordingSession | undefined {
    return this.#sessions.get(guildId);
  }

  isRecording(guildId: string): boolean {
    return this.#sessions.has(guildId);
  }

  get baseDir(): string {
    return this.#baseDir;
  }
}

export const recordingManager = new RecordingManager();
