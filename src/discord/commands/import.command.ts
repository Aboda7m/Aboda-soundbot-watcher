import { defineTextCommand } from "../commandTypes.ts";
import { parseImportCommand } from "../textCommand.ts";

export default defineTextCommand({
  names: ["import"],
  description: "Import a YouTube URL as a sound, optionally trimmed: !import <URL> [from X to Y]",
  parse: parseImportCommand,
  execute: async ({ message, deps }, importCmd) => {
    const { library, prefix, importer } = deps;

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
