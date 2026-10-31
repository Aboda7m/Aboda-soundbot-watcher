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
  /** Resolves when playback ends by itself or is stopped: `null` = finished cleanly, string = error message. Never rejects. */
  readonly ended?: Promise<string | null>;
  stop(): Promise<void>;
}

/** Probed facts about the file being published. */
export interface StreamMedia {
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
}

/** The part that actually sends video+audio to Discord. Kept behind an interface so the rest of the
 * streaming code never depends on a particular Discord library. */
export interface VideoPublisher {
  readonly name: string;
  publish(request: StreamStartOptions & { media: StreamMedia }): Promise<StreamHandle>;
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
