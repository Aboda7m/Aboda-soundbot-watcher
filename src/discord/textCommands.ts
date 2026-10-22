import { Events, type Client } from "discord.js";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { EnqueueResult, SoundQueue } from "../sound/SoundQueue.ts";
import type { ImportService } from "../import/ImportService.ts";
import { matchSoundName, parseSoundCommand, parseImportCommand } from "./textCommand.ts";

const FAIL_TEXT: Record<Extract<EnqueueResult, { ok: false }>["reason"], string> = {
  "unknown-sound": "I don't know that sound.",
  "queue-full": "The queue is full, try again in a moment.",
  duplicate: "That sound is already queued for your channel.",
  "shutting-down": "I'm shutting down.",
};

/** Listens for text commands (`!sound` and `!import`) and feeds the queue or importer. */
export function registerTextCommands(
  client: Client,
  deps: { library: SoundLibrary; queue: SoundQueue; prefix: string; importer?: ImportService },
): void {
  const { library, queue, prefix, importer } = deps;

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot || !message.guild) return;

      // Handle !import command
      const importCmd = parseImportCommand(message.content, prefix);
      if (importCmd) {
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
        return;
      }

      // Handle !sound command
      const cmd = parseSoundCommand(message.content, prefix);
      if (!cmd) return;

      if (cmd.kind === "usage") {
        await message.reply(`Usage: \`${prefix}sound "name"\`  (${library.list().length} sounds available)`);
        return;
      }

      const name = matchSoundName(cmd.name, library.list());
      if (!name) {
        await message.reply(`No sound called "${cmd.name}".`);
        return;
      }

      // Play in the voice channel the caller is currently in.
      const channelId = message.member?.voice.channelId;
      if (!channelId) {
        await message.reply("Join a voice channel first.");
        return;
      }

      const res = queue.enqueue({ sound: name, guildId: message.guild.id, channelId, source: "manual" });
      if (res.ok) await message.react("🔊");
      else await message.reply(FAIL_TEXT[res.reason]);
    } catch (err) {
      console.error("Text command failed:", err);
    }
  });
}