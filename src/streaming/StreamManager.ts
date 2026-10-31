import { basename, extname, resolve, sep } from "node:path";
import { access, constants } from "node:fs/promises";
import type { StreamProvider } from "./StreamProvider.ts";
import { StreamProviderUnavailableError } from "./StreamProvider.ts";
import { StreamSession } from "./StreamSession.ts";

export class StreamManager {
  #sessions = new Map<string, StreamSession>();
  private readonly options: { directory: string; provider: StreamProvider };

  constructor(options: { directory: string; provider: StreamProvider }) {
    this.options = options;
  }

  getProviderInfo() { return this.options.provider.info(); }

  get(guildId: string): StreamSession | null { return this.#sessions.get(guildId) ?? null; }

  list(): StreamSession[] { return [...this.#sessions.values()]; }

  async start(input: { guildId: string; channelId: string; fileName: string; requestedBy: string }): Promise<StreamSession> {
    const fileName = basename(input.fileName.trim());
    if (!fileName || fileName !== input.fileName.trim() || extname(fileName).toLowerCase() !== ".mp4") {
      throw new Error("Use a filename ending in .mp4 from the streams folder, for example: !stream sample.mp4");
    }
    const filePath = resolve(this.options.directory, fileName);
    const root = resolve(this.options.directory) + sep;
    if (!filePath.startsWith(root)) throw new Error("Invalid stream filename.");
    await access(filePath, constants.R_OK);

    const current = this.#sessions.get(input.guildId);
    if (current && current.state !== "stopped" && current.state !== "failed") {
      throw new Error(`A stream session is already ${current.state} in this server. Use !streamstop first.`);
    }

    const session = new StreamSession(input.guildId, input.channelId, fileName, input.requestedBy);
    this.#sessions.set(input.guildId, session);
    try {
      session.handle = await this.options.provider.start({ ...input, filePath });
      session.state = "live";
      // Playback that ends by itself (or dies) must not leave the session "live" forever.
      void session.handle.ended?.then((error) => {
        if (session.state !== "live") return;
        if (error) { session.error = error; session.state = "failed"; }
        else session.state = "stopped";
      });
      return session;
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
      session.state = "failed";
      if (error instanceof StreamProviderUnavailableError) throw error;
      throw new Error(`Could not start stream: ${session.error}`);
    }
  }

  async stop(guildId: string): Promise<StreamSession | null> {
    const session = this.#sessions.get(guildId);
    if (!session) return null;
    await session.stop();
    return session;
  }
}
