import type { StreamHandle } from "./StreamProvider.ts";

export type StreamSessionState = "starting" | "live" | "stopping" | "stopped" | "failed";

export class StreamSession {
  readonly startedAt = Date.now();
  state: StreamSessionState = "starting";
  error: string | null = null;
  handle: StreamHandle | null = null;
  readonly guildId: string;
  readonly channelId: string;
  readonly fileName: string;
  readonly requestedBy: string;

  constructor(guildId: string, channelId: string, fileName: string, requestedBy: string) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.fileName = fileName;
    this.requestedBy = requestedBy;
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "stopping") return;
    this.state = "stopping";
    try {
      await this.handle?.stop();
      this.state = "stopped";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.state = "failed";
      throw error;
    }
  }
}
