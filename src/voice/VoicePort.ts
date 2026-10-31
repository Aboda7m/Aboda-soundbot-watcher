/** Discord-independent voice operations used by the sound queue. */
export interface VoicePort {
  play(guildId: string, channelId: string, filePath: string, maxDurationSec?: number, onStarted?: () => void): Promise<void>;
  stop(guildId: string, channelId?: string): void;
  leave(guildId: string, channelId?: string): void;
  destroyAll(): void;
}
