import { PermissionFlagsBits, type Message } from "discord.js";
import { defineTextCommand, type CommandMessage } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";

type VoiceCommand = "setup" | "status" | "usage";
const WORKER_PERMISSIONS = 1024 + 1048576 + 2097152; // View Channel + Connect + Speak

/** The rule `!voice setup` enforces. `!help` calls it too, so what it shows matches what would be accepted. */
const canSetupVoice = (message: CommandMessage): boolean =>
  Boolean((message as unknown as Message<true>).member?.permissions.has(PermissionFlagsBits.Administrator));

export default defineTextCommand({
  names: ["voice"],
  description: "Show voice worker status or worker invite links: !voice setup | status",
  help: {
    summary: "Show the voice worker bots, or get their invite links.",
    synopsis: "{p}voice <status|setup>",
    usages: [
      { usage: "{p}voice status", summary: "show each voice bot's state and channel in this server", examples: ["{p}voice status"] },
      {
        usage: "{p}voice setup",
        summary: "get the invite link for each voice worker bot",
        examples: ["{p}voice setup"],
        requires: {
          label: "needs the server Administrator permission",
          check: ({ message }) => canSetupVoice(message),
          discoverable: true, // the command already tells everyone else that only an Administrator can do this
        },
        unavailable: ({ guildId, deps }) =>
          deps.voiceHub.describe(guildId).some((slot) => slot.worker) ? undefined : "no voice worker tokens are configured (VOICE_WORKER_1_TOKEN / VOICE_WORKER_2_TOKEN in .env)",
      },
    ],
    notes: ["Discord requires a server Administrator to open each invite link and approve the worker; the main bot cannot do it for you."],
  },
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
      if (!canSetupVoice(message)) {
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
