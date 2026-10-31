/** Backend contract for publishing a video stream to Discord. */
export interface StreamStartOptions {
  guildId: string;
  channelId: string;
  filePath: string;
}

export interface StreamProviderInfo {
  provider: string;
  available: boolean;
  reason?: string;
}

export interface StreamHandle {
  readonly startedAt: number;
  stop(): Promise<void>;
}

export interface StreamProvider {
  info(): StreamProviderInfo;
  start(options: StreamStartOptions): Promise<StreamHandle>;
}

export class StreamProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamProviderUnavailableError";
  }
}
