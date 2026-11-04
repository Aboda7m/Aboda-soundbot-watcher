export type RecordingState =
  | "IDLE"
  | "CONNECTING"
  | "ANNOUNCING"
  | "ACTIVE"
  | "FINALISING"
  | "SAVED"
  | "INTERRUPTED";

export interface ParticipantTrack {
  userId: string;
  /** Path relative to the session folder, e.g. participants/123_1.ogg */
  file: string;
  startedAt: string;
  /** Display name when the segment started (snapshot: stays correct if the user renames later). */
  username?: string;
}

/** "manual" = `!record start` / follow sessions (their manifests carry no `type` at all). */
export type RecordingType = "manual" | "entrance";

/** The bot's own outgoing sound, saved as a track of its own so it can be hidden or left out of an export. */
export interface SoundTrack {
  /** Path relative to the session folder, e.g. participants/entrance_sound.ogg */
  file: string;
  name: string;
  /** When the first packet of the sound was sent. */
  startedAt: string;
  /** When playback actually finished. */
  endedAt?: string;
}

/** Someone who was in the voice channel when an entrance recording started (snapshot). */
export interface ChannelParticipant {
  userId: string;
  username?: string;
  bot?: boolean;
}

export interface RecordingManifest {
  sessionId: string;
  guildId: string;
  channelId: string;
  initiatedBy: string;
  /** Names are snapshots taken at record time, so the archive stays readable without Discord. */
  guildName?: string;
  channelName?: string;
  initiatedByName?: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  status: "active" | "completed" | "interrupted";
  format: string;
  /** Only written for entrance recordings. */
  type?: RecordingType;
  entrant?: { userId: string; username?: string };
  soundName?: string;
  channelParticipants?: ChannelParticipant[];
  reactionTailMs?: number;
  outputs: {
    participants: ParticipantTrack[];
    sound?: SoundTrack;
  };
}
