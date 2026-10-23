// src/discord/commands/sound.command.ts
import type { EnqueueResult } from "../../sound/SoundQueue.ts";
import { defineTextCommand } from "../commandTypes.ts";
import { formatChoices, say } from "../commandUtils.ts";
import { parseSoundCommand, searchSound } from "../textCommand.ts";

const FAIL_TEXT: Record<Extract<EnqueueResult, { ok: false }>["reason"], string> = {
  "unknown-sound": "I don't know that sound.",
  "queue-full": "The queue is full, try again in a moment.",
  duplicate: "That sound is already queued for your channel.",
  "shutting-down": "I'm shutting down.",
};

export default defineTextCommand({
  names: ["sound"],
  description: 'Play a sound in your voice channel: !sound "name" (fuzzy matching, asks when unsure)',
  parse: parseSoundCommand,
  execute: async ({ message, guildId, deps }, cmd) => {
    const { library, queue, prefix } = deps;

    if (cmd.kind === "usage") {
      await message.reply(`Usage: \`${prefix}sound "name"\`  (${library.list().length} sounds available)`);
      return;
    }

    const resolved = searchSound(cmd.name, library.list());
    if (resolved.kind === "none") {
      await say(message, `No sound called "${cmd.name}". Try \`${prefix}soundlist\`.`);
      return;
    }
    if (resolved.kind === "ambiguous") {
      await say(message, `"${cmd.name}" matches several sounds: ${formatChoices(resolved.matches)}. Be more specific.`);
      return;
    }
    if (resolved.kind === "suggest") {
      await say(
        message,
        `I'm not sure which sound you mean by "${cmd.name}". Did you mean: ${formatChoices(resolved.matches)}? Be more specific, or see \`${prefix}soundlist\`.`,
      );
      return;
    }
    const name = resolved.name;

    // Play in the voice channel the caller is currently in.
    const channelId = message.member?.voice.channelId;
    if (!channelId) {
      await message.reply("Join a voice channel first.");
      return;
    }

    const res = queue.enqueue({
      sound: name,
      guildId,
      channelId,
      source: "manual",
      requestedBy: {
        userId: message.author.id,
        username: message.author.tag ?? message.author.username,
      },
    });

    if (res.ok) await message.react("🔊");
    else await message.reply(FAIL_TEXT[res.reason]);
  },
});