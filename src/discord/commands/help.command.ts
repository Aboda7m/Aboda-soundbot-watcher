import { defineTextCommand } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";
import { formatDetail, formatOverview } from "../helpFormat.ts";
import { parseHelpCommand } from "../textCommand.ts";

/**
 * !help / !commands: the command list is derived from the loaded registry and each command's own `help`
 * block, so it cannot drift from what is really installed. Permissions are never re-implemented here: every
 * restricted form carries a `requires.check` that calls the same predicate the command itself enforces.
 */
export default defineTextCommand({
  names: ["help", "commands"],
  description: "List the commands you can use, or show usage and examples for one: !help [command]",
  help: {
    summary: "List the commands you can use, or show usage and examples for one.",
    synopsis: "{p}help [command]",
    usages: [
      { usage: "{p}help", summary: "list the commands you can use", examples: ["{p}help", "{p}commands"] },
      { usage: "{p}help <command>", summary: "show usage and examples for one command", examples: ["{p}help entrance", "{p}help record"] },
    ],
  },
  parse: parseHelpCommand,
  execute: async (context, cmd) => {
    const { message, registry } = context;
    if (!registry) {
      await say(message, "Help is not available right now.");
      return;
    }
    const chunks = cmd.kind === "help-detail" ? formatDetail(registry, cmd.topic, context) : formatOverview(registry, context);
    for (const chunk of chunks) await say(message, chunk);
  },
});
