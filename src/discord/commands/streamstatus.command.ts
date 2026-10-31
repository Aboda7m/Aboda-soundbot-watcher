import { defineTextCommand } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";

export default defineTextCommand({
  names: ["streamstatus"],
  description: "Show video streaming status and publishing backend availability",
  parse: (content, prefix): boolean | null => content.trim().toLowerCase() === `${prefix}streamstatus`.toLowerCase() ? true : null,
  execute: async ({ message, guildId, deps }) => {
    const info = deps.streamManager.getProviderInfo();
    const session = deps.streamManager.get(guildId);
    const sessionText = session
      ? `Session: **${session.state}**\nFile: **${session.fileName}**${session.error ? `\nError: ${session.error}` : ""}`
      : "Session: none";
    await say(message, `**Video streaming**\nBackend: ${info.provider}\nPublishing: ${info.available ? "available" : "unavailable"}\n${info.reason ?? ""}\n${sessionText}`);
  },
});
