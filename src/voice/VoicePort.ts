/** Asks the worker that plays a sound to also record the reactions to it (automatic entrances only). */
export interface EntranceCaptureRequest {
  soundName: string;
  /** Whose entrance this is. */
  entrant?: { userId: string; username?: string | null } | null;
}

export interface PlayOptions {
  captureEntrance?: EntranceCaptureRequest;
}

/** Discord-independent voice operations used by the sound queue. */
export interface VoicePort {
  play(guildId: string, channelId: string, filePath: string, maxDurationSec?: number, onStarted?: () => void, options?: PlayOptions): Promise<void>;
  stop(guildId: string, channelId?: string): void;
  leave(guildId: string, channelId?: string): void;
  destroyAll(): void;
}
