import { Events, PermissionFlagsBits, type Client } from "discord.js";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { EnqueueResult, SoundQueue } from "../sound/SoundQueue.ts";
import type { ImportService } from "../import/ImportService.ts";
import type { SoundRepository } from "../sound/SoundRepository.ts";
import {
  chunkLines,
  escapeMarkdown,
  parseEntranceCommand,
  parseImportCommand,
  parseSoundCommand,
  parseSoundListCommand,
  partialMatches,
  resolveSoundName,
  searchSound,
} from "./textCommand.ts";

const FAIL_TEXT: Record<Extract<EnqueueResult, { ok: false }>["reason"], string> = {
  "unknown-sound": "I don't know that sound.",
  "queue-full": "The queue is full, try again in a moment.",
  duplicate: "That sound is already queued for your channel.",
  "shutting-down": "I'm shutting down.",
};

/** The small slice of a discord.js Message the handlers use. */
export interface CommandMessage {
  author: { id: string; send(content: string): Promise<unknown> };
  member?: {
    permissions: {
      has(permission: bigint): boolean;
    };
  } | null;
  reply(
    options:
      | string
      | {
          content: string;
          allowedMentions?: { parse: never[] };
        },
  ): Promise<unknown>;
}

const NO_MENTIONS = { parse: [] as never[] };
const say = (m: CommandMessage, content: string) =>
  m.reply({ content, allowedMentions: NO_MENTIONS });

/** Shows names as a comma list, ending with "and N more" when truncated. */
function formatChoices(names: string[], max = 10): string {
  const shown = names.slice(0, max).map((n) => `**${escapeMarkdown(n)}**`);
  return shown.join(", ") + (names.length > max ? `, and ${names.length - max} more` : "");
}

/** Server managers and administrators may configure another member's entrance sound. */
function canManageEntrances(message: CommandMessage): boolean {
  const permissions = message.member?.permissions;
  return Boolean(
    permissions?.has(PermissionFlagsBits.ManageGuild) ||
      permissions?.has(PermissionFlagsBits.Administrator),
  );
}

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

/**
 * Resolves and validates a sound name for an entrance assignment.
 */
async function setEntranceForUser(
  message: CommandMessage,
  targetId: string,
  input: string,
  deps: { library: SoundLibrary; repo: SoundRepository; prefix: string },
  targetLabel: string,
): Promise<void> {
  const { library, repo, prefix } = deps;
  const names = library.list();
  const result = resolveSoundName(input, names, { allowPartial: false });

  if (result.kind === "match") {
    repo.setEntrance(targetId, result.name);
    await say(message, `${targetLabel}'s entrance sound is now **${escapeMarkdown(result.name)}**.`);
    return;
  }

  if (result.kind === "ambiguous") {
    await say(
      message,
      `Several sounds are named like that: ${formatChoices(result.matches)}. Use the exact name.`,
    );
    return;
  }

  const similar = partialMatches(input, names);
  await say(
    message,
    `No sound called "${escapeMarkdown(input)}".` +
      (similar.length ? ` Did you mean: ${formatChoices(similar)}?` : ` See \`${prefix}soundlist\`.`),
  );
}

/**
 * Handles all entrance commands for self and managed users.
 */
export async function handleEntrance(
  message: CommandMessage,
  cmd: NonNullable<ReturnType<typeof parseEntranceCommand>>,
  deps: { library: SoundLibrary; repo?: SoundRepository; prefix: string },
): Promise<void> {
  const { library, repo, prefix } = deps;

  if (!repo) {
    await say(message, "Entrance sounds are not available right now.");
    return;
  }

  const userId = message.author.id;

  if (
    cmd.kind === "entrance-target-show" ||
    cmd.kind === "entrance-target-set" ||
    cmd.kind === "entrance-target-clear"
  ) {
    if (!canManageEntrances(message)) {
      await say(
        message,
        "You need the Manage Server or Administrator permission to manage another member's entrance sound.",
      );
      return;
    }

    const targetId = cmd.targetId;
    const targetLabel = `<@${targetId}>`;

    if (cmd.kind === "entrance-target-show") {
      const current = repo.entrance(targetId);
      await say(
        message,
        current
          ? `${targetLabel}'s entrance sound is **${escapeMarkdown(current)}**` +
              (library.has(current)
                ? "."
                : " (that sound no longer exists, so nothing will play).")
          : `${targetLabel} has no entrance sound set.`,
      );
      return;
    }

    if (cmd.kind === "entrance-target-clear") {
      repo.clearEntrance(targetId);
      await say(message, `Cleared ${targetLabel}'s entrance sound.`);
      return;
    }

    if (cmd.kind === "entrance-target-set") {
      await setEntranceForUser(message, targetId, cmd.name, { library, repo, prefix }, targetLabel);
      return;
    }
  }

  if (cmd.kind === "entrance-show") {
    const current = repo.entrance(userId);
    await say(
      message,
      current
        ? `Your entrance sound is **${escapeMarkdown(current)}**` +
            (library.has(current)
              ? "."
              : " (that sound no longer exists, so nothing will play).") +
            ` Change it with \`${prefix}entrance <sound>\` or clear it with \`${prefix}entrance !clear\`.`
        : `You have no entrance sound set. Set one with \`${prefix}entrance <sound>\`.`,
    );
    return;
  }

  if (cmd.kind === "entrance-clear") {
    repo.clearEntrance(userId);
    await say(message, "Cleared your entrance sound.");
    return;
  }

  if (cmd.kind === "entrance-mention") {
    await say(
      message,
      `To manage another user's entrance sound, mention them with a sound or \`!clear\`, e.g. \`${prefix}entrance @User sound-name\` (requires Manage Server permission).`,
    );
    return;
  }

  if (cmd.kind === "entrance-set") {
    await setEntranceForUser(message, userId, cmd.name, { library, repo, prefix }, "Your");
    return;
  }
}

/** Listens for text commands (`!sound`, `!soundlist`, `!entrance`, `!import`) and feeds the queue, repo or importer. */
export function registerTextCommands(
  client: Client,
  deps: { library: SoundLibrary; queue: SoundQueue; prefix: string; importer?: ImportService; repo?: SoundRepository },
): void {
  const { library, queue, prefix, importer, repo } = deps;

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

      if (parseSoundListCommand(message.content, prefix)) {
        await handleSoundList(message, library);
        return;
      }

      const entranceCmd = parseEntranceCommand(message.content, prefix);
      if (entranceCmd) {
        await handleEntrance(message, entranceCmd, { library, repo, prefix });
        return;
      }

      // Handle !sound command
      const cmd = parseSoundCommand(message.content, prefix);
      if (!cmd) return;

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

      const res = queue.enqueue({ sound: name, guildId: message.guild.id, channelId, source: "manual" });
      if (res.ok) await message.react("🔊");
      else await message.reply(FAIL_TEXT[res.reason]);
    } catch (err) {
      console.error("Text command failed:", err);
    }
  });
}