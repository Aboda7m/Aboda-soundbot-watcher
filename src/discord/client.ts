import { Client, GatewayIntentBits } from "discord.js";
import type { VoiceMove } from "../sound/introRules.ts";
import type { VoiceState } from "discord.js";

/** One shared client. MessageContent is a PRIVILEGED intent (needed for the !sound text command): enable it in the Developer Portal. */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
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
