/** Central policy resolver for automatic entrance sound selection and duration. */
export interface EntranceResolutionInput {
  guildEnabled?: boolean;
  adminAssignment?: string; // undefined = no override; empty string = explicit suppression
  userGuildPreference?: string; // undefined = inherit; empty string = disabled
  globalPreference?: string;
  personalDurationSec?: number | null;
  guildDurationSec?: number | null;
  botAdminDurationSec?: number;
}
export interface EntranceResolution { allowed: boolean; sound: string | null; maxDurationSec?: number; reason?: "guild-disabled" | "admin-suppressed" | "user-guild-disabled" | "no-sound"; }
export function resolveAutomaticEntrance(input: EntranceResolutionInput): EntranceResolution {
  if (input.guildEnabled === false) return { allowed: false, sound: null, reason: "guild-disabled" };
  let selected: string | undefined;
  if (input.adminAssignment !== undefined) {
    if (!input.adminAssignment) return { allowed: false, sound: null, reason: "admin-suppressed" };
    selected = input.adminAssignment;
  } else if (input.userGuildPreference !== undefined) {
    if (!input.userGuildPreference) return { allowed: false, sound: null, reason: "user-guild-disabled" };
    selected = input.userGuildPreference;
  } else selected = input.globalPreference;
  if (!selected) return { allowed: false, sound: null, reason: "no-sound" };
  const caps = [input.personalDurationSec, input.guildDurationSec, input.botAdminDurationSec]
    .filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 30);
  return { allowed: true, sound: selected, maxDurationSec: caps.length ? Math.min(...caps) : undefined };
}
