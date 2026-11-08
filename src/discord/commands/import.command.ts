import type { AccessPolicy } from "../../access/AccessPolicy.ts";
import { defineTextCommand, type CommandMessage } from "../commandTypes.ts";
import { parseImportCommand } from "../textCommand.ts";

/** Adding sounds changes the shared library for every server, so it needs an explicit grant from the owner. */
const canImport = (message: CommandMessage, access: AccessPolicy): boolean => access.can(message.author.id, "import");

export default defineTextCommand({
  names: ["import"],
  description: "Import a YouTube URL as a sound, optionally trimmed: !import <URL> [from X to Y]",
  help: {
    summary: "Import a YouTube URL as a new sound, optionally trimmed.",
    synopsis: "{p}import <YouTube URL> [from X to Y]",
    usages: [
      {
        usage: "{p}import <YouTube URL> [from <start> to <end>]",
        summary: "download the audio and add it to the sound library",
        examples: ["{p}import https://www.youtube.com/watch?v=VIDEO_ID", "{p}import https://www.youtube.com/watch?v=VIDEO_ID from 0:05 to 0:12"],
        requires: {
          label: "needs the `import` permission from the bot owner",
          check: ({ message, deps }) => canImport(message, deps.access),
          discoverable: true, // the command already answers "you don't have permission" to everyone else
        },
        unavailable: ({ deps }) => (deps.importer ? undefined : "the import service is disabled on this bot"),
      },
    ],
    notes: [
      "Times are seconds (`90`), `M:SS` (`1:30`) or `H:MM:SS`. A range that is not valid (end not after start) is ignored and the sound is imported without your trim.",
      "The sound is named automatically from the video title (`_1`, `_2`... is added if the name is taken). Play it with `{p}sound \"<name>\"`.",
    ],
  },
  parse: parseImportCommand,
  execute: async ({ message, deps }, importCmd) => {
    const { library, prefix, importer, access } = deps;

    if (!canImport(message, access)) {
      await message.reply("You don't have permission to import sounds. Ask the bot owner to grant it.");
      return;
    }

    if (!importer) {
      await message.reply("The YouTube import service is disabled on this server.");
      return;
    }
    if (importCmd.kind === "import-usage") {
      await message.reply(`Usage: \`${prefix}import <YouTube URL> [from <start> to <end>]\``);
      return;
    }

    const status = await importer.status();
    if (!status.ready) {
      await message.reply(`Import service is not ready: ${status.problem ?? "Unknown error"}`);
      return;
    }

    const processingMsg = await message.reply("⏳ Downloading and processing audio from YouTube...");

    try {
      const staged = await importer.importYouTube(importCmd.url);

      if (importCmd.startSec !== undefined && importCmd.endSec !== undefined) {
        await importer.process(staged.id, {
          mode: "range",
          start: importCmd.startSec,
          end: importCmd.endSec,
        });
      }

      let soundName = staged.suggestedName || "youtube_sound";
      let finalName = soundName;
      let counter = 1;
      while (library.has(finalName)) {
        finalName = `${soundName}_${counter++}`;
      }

      const saved = await importer.save(staged.id, finalName);
      library.invalidate();

      await processingMsg.edit(`✅ Successfully imported and saved sound: **\`${saved.name}\`**! Play it using \`${prefix}sound "${saved.name}"\``);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error occurred.";
      await processingMsg.edit(`❌ Import failed: ${errorMsg}`);
    }
  },
});
