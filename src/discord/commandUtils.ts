/** Small reply helpers shared by several command modules. */
import { escapeMarkdown } from "./textCommand.ts";
import type { CommandMessage } from "./commandTypes.ts";

export const NO_MENTIONS = { parse: [] as never[] };

/** Replies without pinging anyone, even if the text contains mentions. */
export const say = (m: CommandMessage, content: string) =>
  m.reply({ content, allowedMentions: NO_MENTIONS });

/** Shows names as a comma list, ending with "and N more" when truncated. */
export function formatChoices(names: string[], max = 10): string {
  const shown = names.slice(0, max).map((n) => `**${escapeMarkdown(n)}**`);
  return shown.join(", ") + (names.length > max ? `, and ${names.length - max} more` : "");
}
