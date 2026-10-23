import type { SoundLibrary } from "../../sound/SoundLibrary.ts";
import { defineTextCommand, type CommandMessage } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";
import { chunkLines, escapeMarkdown, parseSoundListCommand } from "../textCommand.ts";

/** !soundlist: DM every sound name, sorted, in chunks below Discord's message limit. */
export async function handleSoundList(
  message: CommandMessage,
  library: SoundLibrary,
): Promise<void> {
  const names = [...library.list()].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    await say(message, "There are no sounds in the library yet.");
    return;
  }

  const chunks = chunkLines(
    names.map((n) => `• ${escapeMarkdown(n)}`),
    undefined,
    `**Available sounds (${names.length}):**\n`,
  );

  try {
    for (const chunk of chunks) {
      await message.author.send(chunk);
    }
  } catch {
    await say(
      message,
      "I couldn't DM you. Check that your DMs from server members are enabled and try again.",
    );
    return;
  }

  await say(message, `📬 Sent you a DM with all ${names.length} sound names.`);
}

export default defineTextCommand({
  names: ["soundlist"],
  description: "DM the full list of sound names",
  parse: parseSoundListCommand,
  execute: async ({ message, deps }) => {
    await handleSoundList(message, deps.library);
  },
});
