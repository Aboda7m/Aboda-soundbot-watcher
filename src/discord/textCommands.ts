/**
 * Text command entry point: discovers command modules at startup and dispatches messages to them.
 * Each command lives in `./commands/<name>.command.ts`; see `commandTypes.ts` for the contract.
 */
import { Events, type Client } from "discord.js";
import { describeRegistry, loadCommands, type CommandRegistry } from "./commandRegistry.ts";
import type { CommandDeps, IncomingMessage } from "./commandTypes.ts";

// Compatibility re-exports: these used to be defined in this file.
export type { CommandDeps, CommandMessage } from "./commandTypes.ts";
export { handleEntrance } from "./commands/entrance.command.ts";
export { handleSoundList } from "./commands/soundlist.command.ts";

/**
 * The command word of a message, lowercase and without the prefix (`"!RM-Entrance x"` -> `"rm-entrance"`),
 * or null when the first word does not start with the prefix. Only used to pick the candidate command;
 * that command's own `parse` still decides whether the message really is for it.
 */
export function commandWord(content: string, prefix: string): string | null {
  const first = content.trim().split(/\s/, 1)[0]!.toLowerCase();
  const head = prefix.toLowerCase();
  return first.startsWith(head) ? first.slice(head.length) : null;
}

/** Routes one message to its command. Never throws: failures are logged like before. */
export async function handleTextMessage(
  message: IncomingMessage,
  registry: CommandRegistry,
  deps: CommandDeps,
): Promise<void> {
  try {
    if (message.author.bot || !message.guild) return;

    const word = commandWord(message.content, deps.prefix);
    if (word === null) return;
    const entry = registry.lookup(word);
    if (!entry) return;

    const parsed = entry.command.parse(message.content, deps.prefix);
    if (parsed === null) return;

    await entry.command.execute({ message, guildId: message.guild.id, deps }, parsed);
  } catch (err) {
    console.error("Text command failed:", err);
  }
}

export interface RegisterOptions {
  /** Where to discover command modules. Default: `./commands/` next to this file. */
  commandsDir?: URL;
  /** Startup log line sink. Default: console.log. */
  log?: (line: string) => void;
}

/**
 * Loads every command module, then listens for text commands (`!sound`, `!soundlist`, `!entrance`,
 * `!import`, ...). Rejects with a `CommandLoadError` if any command module is invalid; call it before
 * logging in so a broken command stops startup instead of failing at runtime.
 */
export async function registerTextCommands(
  client: Client,
  deps: CommandDeps,
  options: RegisterOptions = {},
): Promise<void> {
  const registry = await loadCommands(options.commandsDir);
  (options.log ?? console.log)(`Text commands (prefix "${deps.prefix}"): ${describeRegistry(registry)}`);

  client.on(Events.MessageCreate, async (message) => {
    await handleTextMessage(message, registry, deps);
  });
}
