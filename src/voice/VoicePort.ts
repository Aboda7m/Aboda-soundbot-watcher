/**
 * The ONLY thing the rest of the app knows about voice. Everything Discord-voice-specific
 * (joining, encryption, players, FFmpeg, Opus) lives behind this interface in src/voice/.
 * If Discord changes its voice API, only DiscordVoiceAdapter.ts / AudioProvider.ts change.
 */
export interface VoicePort {
  /** Join (or reuse) the channel and play one file. Resolves when it finishes or is stopped; rejects on failure. */
  play(guildId: string, channelId: string, filePath: string, maxDurationSec?: number, onStarted?: () => void): Promise<void>;
  /** Stop whatever is playing in this guild (the pending play() resolves). */
  stop(guildId: string): void;
  /** Leave the voice channel in this guild. */
  leave(guildId: string): void;
  /** Leave everywhere (shutdown). */
  destroyAll(): void;
}
