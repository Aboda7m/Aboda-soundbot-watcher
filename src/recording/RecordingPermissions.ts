import type { AccessPolicy } from "../access/AccessPolicy.ts";

/** The slice of a discord.js GuildMember this check needs. */
export interface RecordingMember {
  id: string;
  permissions: { has(permission: bigint): boolean };
}

const ADMINISTRATOR = 1n << 3n;
const MANAGE_CHANNELS = 1n << 4n;
const MOVE_MEMBERS = 1n << 24n;

export class RecordingPermissions {
  /**
   * Who may start/stop a recording: bot owners (access.json / OWNER_USER_IDS),
   * Discord Administrators, or members holding BOTH Manage Channels and Move Members.
   */
  static canUserRecord(member: RecordingMember, access: AccessPolicy): boolean {
    if (access.isOwner(member.id)) return true;
    if (member.permissions.has(ADMINISTRATOR)) return true;
    return member.permissions.has(MANAGE_CHANNELS) && member.permissions.has(MOVE_MEMBERS);
  }
}
