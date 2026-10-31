import { Client, GatewayIntentBits } from "discord.js";
import type { VoiceMove } from "../sound/introRules.ts";
import type { VoiceState } from "discord.js";

/** One shared client. MessageContent and GuildMembers are PRIVILEGED intents (needed for member enumeration and the !sound text command): enable it in the Developer Portal. */
export function createClient(worker = false): Client {
  return new Client({
    intents: worker
      ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
      : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
}

/** Translate a discord.js voice-state change into the plain data the intro rules use. */
export function toVoiceMove(oldState: VoiceState, newState: VoiceState): VoiceMove | null {
  const user = newState.member?.user ?? oldState.member?.user;
  if (!user) return null; // member not resolvable: cannot attribute the event
  return {
    userId: user.id,
    isBot: user.bot,
    guildId: newState.guild.id,
    fromChannelId: oldState.channelId,
    toChannelId: newState.channelId,
  };
}
