import { Events, type Client } from "discord.js";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { EnqueueResult, SoundQueue } from "../sound/SoundQueue.ts";
import { matchSoundName, parseSoundCommand } from "./textCommand.ts";

const FAIL_TEXT: Record<Extract<EnqueueResult, { ok: false }>["reason"], string> = {
  "unknown-sound": "I don't know that sound.",
  "queue-full": "The queue is full, try again in a moment.",
  duplicate: "That sound is already queued for your channel.",
  "shutting-down": "I'm shutting down.",
};

/** Listens for `!sound "name"` and feeds the same queue the web page uses. */
export function registerTextCommands(
  client: Client,
  deps: { library: SoundLibrary; queue: SoundQueue; prefix: string },
): void {
  const { library, queue, prefix } = deps;

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot || !message.guild) return;
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
