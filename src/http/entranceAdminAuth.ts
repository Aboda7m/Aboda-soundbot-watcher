/** Pure permission decision: a guild owner or a member with Administrator/Manage Server may administer that guild. */
export function mayAdministerGuild(
  userId: string,
  guildOwnerId: string,
  permissions: { hasAdministrator: boolean; hasManageGuild: boolean },
): boolean {
  return userId === guildOwnerId || permissions.hasAdministrator || permissions.hasManageGuild;
}
