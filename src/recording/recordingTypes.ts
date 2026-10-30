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
}

export interface RecordingManifest {
  sessionId: string;
  guildId: string;
  channelId: string;
  initiatedBy: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  status: "active" | "completed" | "interrupted";
  format: string;
  outputs: {
    participants: ParticipantTrack[];
  };
}
