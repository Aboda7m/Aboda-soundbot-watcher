import { defineTextCommand } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";

export default defineTextCommand({
  names: ["streamstop"],
  description: "Stop the current video stream",
  parse: (content, prefix): boolean | null => content.trim().toLowerCase() === `${prefix}streamstop`.toLowerCase() ? true : null,
  execute: async ({ message, guildId, deps }) => {
    if (!deps.access.isOwner(message.author.id)) {
      await say(message, "Only a bot owner can stop a video stream.");
      return;
    }
    try {
      const session = await deps.streamManager.stop(guildId);
      await say(message, session ? `Stopped stream **${session.fileName}**.` : "There is no stream session in this server.");
    } catch (error) {
      await say(message, `Could not stop the stream: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
