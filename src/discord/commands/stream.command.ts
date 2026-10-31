import { defineTextCommand } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";

export default defineTextCommand({
  names: ["stream"],
  description: "Start streaming an MP4 from the streams folder: !stream filename.mp4",
  parse: (content, prefix): string | null => {
    const [command, ...args] = content.trim().split(/\s+/);
    if (command?.toLowerCase() !== `${prefix}stream`.toLowerCase()) return null;
    return args.length === 1 ? args[0]! : "";
  },
  execute: async ({ message, guildId, deps }, fileName) => {
    if (!deps.access.isOwner(message.author.id)) {
      await say(message, "Only a bot owner can start a video stream.");
      return;
    }
    if (!fileName) {
      await say(message, `Usage: \`${deps.prefix}stream filename.mp4\`\nPlace the MP4 inside the \`streams\` folder.`);
      return;
    }
    const channelId = message.member?.voice.channelId;
    if (!channelId) {
      await say(message, "Join the voice channel where you want the stream to appear first.");
      return;
    }
    try {
      const session = await deps.streamManager.start({ guildId, channelId, fileName, requestedBy: message.author.id });
      await say(message, `Stream started: **${session.fileName}**`);
    } catch (error) {
      await say(message, error instanceof Error ? error.message : String(error));
    }
  },
});
