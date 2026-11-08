import type { SoundLibrary } from "../../sound/SoundLibrary.ts";
import type { SoundRepository } from "../../sound/SoundRepository.ts";
import { defineTextCommand, type CommandContext, type CommandMessage } from "../commandTypes.ts";
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

const needsRepo = ({ deps }: CommandContext): string | undefined => (deps.repo ? undefined : "exit sounds are not available right now");

export default defineTextCommand({
  names: ["exit"],
  description: "Show, set or clear your exit sound (plays when you leave voice)",
  help: {
    summary: "Show, set or clear the sound played when you leave a voice channel.",
    synopsis: "{p}exit [<sound> | {p}clear]",
    usages: [
      { usage: "{p}exit", summary: "show your exit sound", examples: ["{p}exit"], unavailable: needsRepo },
      { usage: "{p}exit <sound>", summary: "set your exit sound", examples: ['{p}exit "air horn"'], unavailable: needsRepo },
      { usage: "{p}exit {p}clear", summary: "clear your exit sound", examples: ["{p}exit {p}clear"], unavailable: needsRepo },
    ],
    notes: [
      "The sound name must match exactly (letter case is ignored). If nothing matches I suggest similar names; `{p}soundlist` shows them all.",
      "It plays when you leave voice, and also when you switch to another channel. A cooldown may skip repeats.",
    ],
  },
  parse: parseExitCommand,
  execute: async ({ message, deps }, cmd) => {
    await handleExit(message, cmd, { library: deps.library, repo: deps.repo, prefix: deps.prefix });
  },
});
