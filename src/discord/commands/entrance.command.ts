import type { AccessPolicy } from "../../access/AccessPolicy.ts";
import type { SoundLibrary } from "../../sound/SoundLibrary.ts";
import type { SoundRepository } from "../../sound/SoundRepository.ts";
import { defineTextCommand, type CommandContext, type CommandMessage, type HelpRequirement } from "../commandTypes.ts";
import { formatChoices, say } from "../commandUtils.ts";
import { escapeMarkdown, parseEntranceCommand, partialMatches, resolveSoundName } from "../textCommand.ts";

/**
 * Only the bot's owners, and users the owner explicitly granted `entrance.manage`, may configure ANOTHER
 * member's entrance sound. Discord's Manage Server / Administrator no longer count: everybody has them
 * in a server of their own.
 */
const canManageEntrances = (message: CommandMessage, access: AccessPolicy): boolean =>
  access.can(message.author.id, "entrance.manage");

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
  deps: { library: SoundLibrary; repo?: SoundRepository; prefix: string; access: AccessPolicy },
): Promise<void> {
  const { library, repo, prefix, access } = deps;

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
    if (!canManageEntrances(message, access)) {
      await say(message, "You don't have permission to manage another member's entrance sound. Ask the bot owner to grant it.");
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
      `To manage another user's entrance sound, mention them with a sound or \`!clear\`, e.g. \`${prefix}entrance @User sound-name\` (needs a permission from the bot owner).`,
    );
    return;
  }

  if (cmd.kind === "entrance-set") {
    await setEntranceForUser(message, userId, cmd.name, { library, repo, prefix }, "Your");
    return;
  }
}

const MANAGE_OTHERS: HelpRequirement = {
  label: "needs the `entrance.manage` permission from the bot owner",
  check: ({ message, deps }) => canManageEntrances(message, deps.access),
  discoverable: true, // the command already tells everyone else that this needs a permission
};
const needsRepo = ({ deps }: CommandContext): string | undefined => (deps.repo ? undefined : "entrance sounds are not available right now");

// `!RM-entrance` is the same command: parseEntranceCommand recognises both spellings.
export default defineTextCommand({
  names: ["entrance", "rm-entrance"],
  description: "Show, set or clear an entrance sound (managing others needs the entrance.manage permission)",
  help: {
    summary: "Show, set or clear the sound played when you join a voice channel.",
    synopsis: "{p}entrance [<sound> | {p}clear]",
    usages: [
      { usage: "{p}entrance", summary: "show your entrance sound", examples: ["{p}entrance"], unavailable: needsRepo },
      { usage: "{p}entrance <sound>", summary: "set your entrance sound", examples: ['{p}entrance "air horn"'], unavailable: needsRepo },
      { usage: "{p}entrance {p}clear", summary: "clear your entrance sound", examples: ["{p}entrance {p}clear"], unavailable: needsRepo },
      { usage: "{p}rm-entrance", summary: "clear your entrance sound (same as above)", examples: ["{p}rm-entrance"], unavailable: needsRepo },
      { usage: "{p}entrance @user", summary: "show another member's entrance sound", examples: ["{p}entrance @Sam"], requires: MANAGE_OTHERS, unavailable: needsRepo },
      { usage: "{p}entrance @user <sound>", summary: "set another member's entrance sound", examples: ['{p}entrance @Sam "air horn"'], requires: MANAGE_OTHERS, unavailable: needsRepo },
      { usage: "{p}entrance @user {p}clear", summary: "clear another member's entrance sound", examples: ["{p}entrance @Sam {p}clear"], requires: MANAGE_OTHERS, unavailable: needsRepo },
    ],
    notes: [
      "The sound name must match exactly (letter case is ignored). If nothing matches I suggest similar names; `{p}soundlist` shows them all.",
      "It plays when you join voice from outside a channel, not when you switch between channels. The server's entrance settings and cooldowns can also apply.",
    ],
  },
  parse: parseEntranceCommand,
  execute: async ({ message, deps }, cmd) => {
    await handleEntrance(message, cmd, { library: deps.library, repo: deps.repo, prefix: deps.prefix, access: deps.access });
  },
});
