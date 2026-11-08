import type { SoundLibrary } from "../../sound/SoundLibrary.ts";
import type { SoundRepository } from "../../sound/SoundRepository.ts";
import { defineTextCommand, type CommandMessage } from "../commandTypes.ts";
import { formatChoices, say } from "../commandUtils.ts";
import { escapeMarkdown, parseExitCommand, partialMatches, resolveSoundName } from "../textCommand.ts";

/** Handles `!exit`, `!exit <sound>` and `!exit !clear`. Always acts on the message author only. */
export async function handleExit(
  message: CommandMessage,
  cmd: NonNullable<ReturnType<typeof parseExitCommand>>,
  deps: { library: SoundLibrary; repo?: SoundRepository; prefix: string },
): Promise<void> {
  const { library, repo, prefix } = deps;

  if (!repo) {
    await say(message, "Exit sounds are not available right now.");
    return;
  }

  const userId = message.author.id;

  if (cmd.kind === "exit-show") {
    const current = repo.exit(userId);
    await say(
      message,
      current
        ? `Your exit sound is **${escapeMarkdown(current)}**` +
            (library.has(current) ? "." : " (that sound no longer exists, so nothing will play).") +
            ` Change it with \`${prefix}exit <sound>\` or clear it with \`${prefix}exit !clear\`.`
        : `You have no exit sound set. Set one with \`${prefix}exit <sound>\`.`,
    );
    return;
  }

  if (cmd.kind === "exit-clear") {
    repo.clearExit(userId);
    await say(message, "Cleared your exit sound.");
    return;
  }

  const names = library.list();
  const result = resolveSoundName(cmd.name, names, { allowPartial: false });

  if (result.kind === "match") {
    repo.setExit(userId, result.name);
    await say(message, `Your exit sound is now **${escapeMarkdown(result.name)}**.`);
    return;
  }

  if (result.kind === "ambiguous") {
    await say(message, `Several sounds are named like that: ${formatChoices(result.matches)}. Use the exact name.`);
    return;
  }

  const similar = partialMatches(cmd.name, names);
  await say(
    message,
    `No sound called "${escapeMarkdown(cmd.name)}".` +
      (similar.length ? ` Did you mean: ${formatChoices(similar)}?` : ` See \`${prefix}soundlist\`.`),
  );
}

export default defineTextCommand({
  names: ["exit"],
  description: "Show, set or clear your exit sound (plays when you leave voice)",
  parse: parseExitCommand,
  execute: async ({ message, deps }, cmd) => {
    await handleExit(message, cmd, { library: deps.library, repo: deps.repo, prefix: deps.prefix });
  },
});
