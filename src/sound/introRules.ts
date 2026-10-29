/** Pure rules for automatic intro/outro sounds. No Discord objects, no I/O: easy to test and to change. */

export interface VoiceMove {
  userId: string;
  isBot: boolean;
  guildId: string;
  fromChannelId: string | null;
  toChannelId: string | null;
}
export interface IntroPlan {
  kind: "entrance" | "exit";
  sound: string;
  guildId: string;
  channelId: string;
}
export interface IntroLookup {
  entrance(userId: string, guildId?: string): string | undefined;
  exit(userId: string): string | undefined;
  hasSound(name: string): boolean;
}

/**
 * Same rules as the legacy bot, with channel IDs compared instead of objects:
 *  - leaving a channel                         -> the user's exit sound plays in the channel they left
 *  - joining from outside voice                -> the user's entrance sound plays in the channel they entered
 *  - moving between channels                    -> exit sound only; channel moves are not fresh entrances
 *  - mute/deafen/stream changes (same channel)  -> no sound
 * Bots never trigger intros.
 */
export function planIntros(move: VoiceMove, lookup: IntroLookup): IntroPlan[] {
  if (move.isBot) return [];
  if (move.fromChannelId === move.toChannelId) return [];
  const plans: IntroPlan[] = [];

  if (move.fromChannelId) {
    const sound = lookup.exit(move.userId);
    if (sound && lookup.hasSound(sound))
      plans.push({ kind: "exit", sound, guildId: move.guildId, channelId: move.fromChannelId });
  }
  if (move.toChannelId && !move.fromChannelId) {
    const sound = lookup.entrance(move.userId, move.guildId);
    if (sound && lookup.hasSound(sound))
      plans.push({ kind: "entrance", sound, guildId: move.guildId, channelId: move.toChannelId });
  }
  return plans;
}

/**
 * Entrance sounds are for joining from outside voice, not switching between channels.
 * Channel moves may still play the exit sound for the channel being left.
 */
export function shouldPlayEntrance(move: Pick<VoiceMove, "fromChannelId" | "toChannelId">): boolean {
  return move.toChannelId !== null && move.fromChannelId === null;
}

/** Returns true if the key is allowed now, false while it is cooling down. */
export function createCooldown(ms: number, now: () => number = Date.now) {
  const last = new Map<string, number>();
  return (key: string): boolean => {
    const t = now();
    for (const [k, v] of last) if (t - v >= ms) last.delete(k); // keeps the map from growing
    const prev = last.get(key);
    if (prev !== undefined && t - prev < ms) return false;
    last.set(key, t);
    return true;
  };
}
