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
  outputs: {
    participants: ParticipantTrack[];
  };
}
