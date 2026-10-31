import { PermissionFlagsBits, type Message } from "discord.js";
import { defineTextCommand } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";

type VoiceCommand = "setup" | "status" | "usage";
const WORKER_PERMISSIONS = 1024 + 1048576 + 2097152; // View Channel + Connect + Speak

export default defineTextCommand({
  names: ["voice"],
  description: "Show voice worker status or worker invite links: !voice setup | status",
  parse: (content, prefix): VoiceCommand | null => {
    const [first = "", sub = ""] = content.trim().split(/\s+/);
    if (first.toLowerCase() !== `${prefix}voice`.toLowerCase()) return null;
    const value = sub.toLowerCase();
    return value === "setup" || value === "status" ? value : "usage";
  },
  execute: async ({ message, guildId, deps }, cmd) => {
    if (cmd === "usage") {
      await say(message, `**Usage:**\n\`${deps.prefix}voice setup\` - worker invite links (server Administrator)\n\`${deps.prefix}voice status\` - connected voice worker status`);
      return;
    }
    if (cmd === "setup") {
      const msg = message as unknown as Message<true>;
      if (!msg.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await say(message, "Only a server Administrator can authorize the worker bots.");
        return;
      }
      const workers = deps.voiceHub.describe(guildId).filter((slot) => slot.worker);
      if (!workers.length) {
        await say(message, "No worker tokens are configured. Add VOICE_WORKER_1_TOKEN and/or VOICE_WORKER_2_TOKEN to .env, then restart the bot.");
        return;
      }
      const links = workers.map((slot) => slot.userId
        ? `**${slot.label}**: https://discord.com/oauth2/authorize?client_id=${slot.userId}&scope=bot&permissions=${WORKER_PERMISSIONS}`
        : `**${slot.label}**: not logged in, so no invite link is available.`);
      await say(message, `Authorize each worker using its link below. Discord requires an Administrator to open the link and approve the bot; the main bot cannot authorize it automatically.\n\n${links.join("\n")}`);
      return;
    }
    const lines = deps.voiceHub.describe(guildId).map((slot) => {
      const location = slot.channelId ? `<#${slot.channelId}>` : "not connected";
      return `• **${slot.label}**${slot.tag ? ` (${slot.tag})` : ""}: ${slot.inGuild ? slot.state : "not in this server"}; ${location}`;
    });
    await say(message, lines.length ? `**Voice pool**\n${lines.join("\n")}` : "No voice slots configured.");
  },
});
