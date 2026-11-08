import { resolveAutomaticEntrance } from "../../sound/entranceResolver.ts";
import type { SoundLibrary } from "../../sound/SoundLibrary.ts";
import type { SoundRepository } from "../../sound/SoundRepository.ts";
import { defineTextCommand, type CommandContext, type HelpRequirement } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";
import { chunkLines, escapeMarkdown, MAX_MESSAGE_CHARS } from "../textCommand.ts";
import { isGuildPolicyAdmin } from "./entrance-policy.command.ts";

/**
 * Manage the per-server entrance OVERRIDES that administrators set on the dashboard (assigned sound, or suppressed).
 * Clearing one RELEASES it (`releaseGuildEntrance`: the entry is deleted, not turned into a suppression), so the
 * member's own entrance sound applies again. Only `guildEntrances[<this server>]` is ever touched: never personal
 * entrance sounds, members' own per-server preferences, the server policy, or other servers.
 *
 * Access is exactly `!entrance-policy`'s (`isGuildPolicyAdmin`): bot owners, `entrance.manage`, or Discord
 * Administrator / Manage Server. Everyone else gets no reply, so the command does not reveal that it exists.
 */
const USER = /^<@!?(\d{15,25})>$|^(\d{15,25})$/;
const MAX_LISTED = 50;

export type GuildEntranceAction =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "clear"; userId: string }
  | { kind: "clear-all"; confirm: boolean }
  | { kind: "usage"; sub: string };

export function parseGuildEntranceCommand(content: string, prefix = "!"): GuildEntranceAction | null {
  const text = content.trim();
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const match = /^guild-entrance(?:\s+(.*))?$/is.exec(text.slice(prefix.length));
  if (!match) return null;
  const [sub = "", ...args] = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
  switch (sub.toLowerCase()) {
    case "":
      return { kind: "help" };
    case "list":
      return args.length === 0 ? { kind: "list" } : { kind: "usage", sub: "list" };
    case "clear": {
      const m = args.length === 1 ? USER.exec(args[0]!) : null;
      const userId = m ? (m[1] ?? m[2]) : undefined;
      return userId ? { kind: "clear", userId } : { kind: "usage", sub: "clear" };
    }
    case "clear-all":
      // Only the exact word `confirm` is destructive; any other extra word is a usage error, never a delete.
      if (args.length === 0) return { kind: "clear-all", confirm: false };
      return args.length === 1 && args[0]!.toLowerCase() === "confirm" ? { kind: "clear-all", confirm: true } : { kind: "usage", sub: "clear-all" };
    default:
      return { kind: "usage", sub: "" };
  }
}

const needsRepo = ({ deps }: CommandContext): string | undefined => (deps.repo ? undefined : "entrance settings are unavailable right now");

/** Not `discoverable`: the command is silent for people without access, so `!help` must not reveal it to them either. */
const GUILD_ADMIN: HelpRequirement = {
  label: "needs server Administrator or Manage Server, or the `entrance.manage` permission",
  check: ({ message, deps }) => isGuildPolicyAdmin(message, deps.access),
};
const form = (usage: string, summary: string, examples: string[]) => ({ usage, summary, examples, requires: GUILD_ADMIN, unavailable: needsRepo });

const EXPLANATION = (p: string) => [
  "**Guild entrance overrides**",
  "An override is a decision an administrator made about ONE member's entrance sound in THIS server only (set on the dashboard's entrance admin page). It is either:",
  "• **assigned**: that sound plays when they join here, instead of their own;",
  "• **suppressed**: no entrance sound plays for them here, even if they have a personal one.",
  "",
  "**Why a personal entrance sound may not play:** when someone joins voice from outside a channel the bot checks, in this order: automatic entrances disabled for the server (`" + p + "entrance-policy`) → an override for them (this command) → their own setting for this server → their personal entrance sound. An override wins over the member's own sounds, so a suppressed member stays silent here whatever they set with `" + p + "entrance`.",
  "",
  "**Clearing releases the override.** The member's personal entrance sound then applies again. Personal sounds, members' own settings, the server policy and other servers are never changed.",
  "",
  `\`${p}guild-entrance list\` - who has an override here, and which kind`,
  `\`${p}guild-entrance clear @user\` - release one member's override`,
  `\`${p}guild-entrance clear-all\` - preview how many overrides would be removed`,
  `\`${p}guild-entrance clear-all confirm\` - remove them all`,
];

const SHORT_USAGE: Record<string, (p: string) => string> = {
  list: (p) => `Usage: \`${p}guild-entrance list\``,
  clear: (p) => `Usage: \`${p}guild-entrance clear <@user|id>\``,
  "clear-all": (p) => `Use \`${p}guild-entrance clear-all\` to preview, or \`${p}guild-entrance clear-all confirm\` to remove every override in this server.`,
};

const sound = (name: string) => `**${escapeMarkdown(name)}**`;
const who = (id: string) => `<@${id}> (${id})`;

function describe(o: { userId: string; sound: string | null }, library: SoundLibrary): string {
  if (o.sound === null) return `${who(o.userId)} - suppressed (no entrance sound plays here)`;
  return `${who(o.userId)} - assigned ${sound(o.sound)}${library.has(o.sound) ? "" : " (that sound no longer exists, so nothing plays)"}`;
}

/** What the member's entrance does once their override is gone, using the same resolver the bot uses when they join. */
function effectNow(repo: SoundRepository, library: SoundLibrary, guildId: string, userId: string): string {
  const r = resolveAutomaticEntrance({
    guildEnabled: repo.guildEntranceSettings(guildId).enabled,
    adminAssignment: undefined, // just released
    userGuildPreference: repo.userGuildEntrance(userId, guildId),
    globalPreference: repo.entrance(userId),
  });
  if (r.allowed && r.sound) return `Their own entrance sound applies again: ${sound(r.sound)}${library.has(r.sound) ? "." : " (that sound no longer exists, so nothing plays)."}`;
  switch (r.reason) {
    case "guild-disabled": return "Automatic entrance sounds are disabled in this server, so nothing plays.";
    case "user-guild-disabled": return "They turned entrance sounds off for this server themselves, so nothing plays.";
    default: return "They have no personal entrance sound set, so nothing plays.";
  }
}

async function run({ message, guildId, deps }: CommandContext, action: GuildEntranceAction): Promise<void> {
  if (!isGuildPolicyAdmin(message, deps.access)) return; // silent for everyone else
  const { repo, library, prefix: p } = deps;
  const reply = (text: string) => say(message, text);
  if (!repo) return void (await reply("Entrance settings are unavailable right now."));

  switch (action.kind) {
    case "help":
      for (const chunk of chunkLines(EXPLANATION(p), MAX_MESSAGE_CHARS)) await reply(chunk);
      return;

    case "usage":
      return void (await reply(SHORT_USAGE[action.sub]?.(p) ?? `Use \`${p}guild-entrance\` for an explanation, or \`list\`, \`clear @user\`, \`clear-all\`.`));

    case "list": {
      const all = repo.guildEntranceOverrides(guildId);
      if (all.length === 0) return void (await reply("No guild entrance overrides in this server. Members' own entrance sounds apply."));
      const assigned = all.filter((o) => o.sound !== null).length;
      const lines = all.slice(0, MAX_LISTED).map((o) => describe(o, library));
      if (all.length > MAX_LISTED) lines.push(`...and ${all.length - MAX_LISTED} more (the dashboard's entrance admin page shows everyone).`);
      for (const chunk of chunkLines(lines, MAX_MESSAGE_CHARS, `**Guild entrance overrides** - ${all.length} (${assigned} assigned, ${all.length - assigned} suppressed)\n`)) await reply(chunk);
      return;
    }

    case "clear": {
      const before = repo.guildEntranceAssignment(action.userId, guildId);
      if (before === undefined || !repo.releaseGuildEntrance(guildId, action.userId)) {
        return void (await reply(`${who(action.userId)} has no guild entrance override in this server. Nothing changed.`));
      }
      const was = before === "" ? "suppressed" : `assigned ${sound(before)}`;
      return void (await reply(`Released the guild override for ${who(action.userId)} (was ${was}). ${effectNow(repo, library, guildId, action.userId)}`));
    }

    case "clear-all": {
      const all = repo.guildEntranceOverrides(guildId);
      if (all.length === 0) return void (await reply("No guild entrance overrides in this server, so there is nothing to clear."));
      const assigned = all.filter((o) => o.sound !== null).length;
      const breakdown = `${all.length} override${all.length === 1 ? "" : "s"} (${assigned} assigned, ${all.length - assigned} suppressed)`;
      if (!action.confirm) {
        return void (await reply(
          `This would remove **${breakdown}** in this server. Every affected member's own entrance sound would apply here again, including members who are currently suppressed.\n` +
            "Personal entrance sounds, members' own settings, the server policy and other servers are not touched.\n" +
            `To go ahead, run \`${p}guild-entrance clear-all confirm\`.`,
        ));
      }
      const removed = repo.releaseAllGuildEntrances(guildId);
      return void (await reply(`Removed **${removed}** guild entrance override${removed === 1 ? "" : "s"}. Members' own entrance sounds apply again in this server.`));
    }
  }
}

export default defineTextCommand({
  names: ["guild-entrance"],
  description: "Admins: explain, list and clear this server's per-member entrance overrides",
  help: {
    summary: "Explain, list and clear this server's per-member entrance overrides.",
    synopsis: "{p}guild-entrance [list|clear|clear-all]",
    usages: [
      form("{p}guild-entrance", "explain what overrides are and why one can stop a personal entrance sound from playing", ["{p}guild-entrance"]),
      form("{p}guild-entrance list", "list every member with an override here: id, and assigned sound or suppressed", ["{p}guild-entrance list"]),
      form("{p}guild-entrance clear <@user|id>", "release one member's override so their own entrance sound applies again", ["{p}guild-entrance clear @Sam", "{p}guild-entrance clear 123456789012345678"]),
      form("{p}guild-entrance clear-all", "preview how many overrides would be removed (changes nothing)", ["{p}guild-entrance clear-all"]),
      form("{p}guild-entrance clear-all confirm", "remove every override in this server", ["{p}guild-entrance clear-all confirm"]),
    ],
    notes: [
      "Overrides are assigned or suppressed on the dashboard's entrance admin page; this command only lists and releases them.",
      "Clearing never changes anyone's personal entrance sound, their own per-server settings, the server's entrance policy, or other servers.",
      "Members who left the server can still be cleared by id.",
    ],
  },
  parse: parseGuildEntranceCommand,
  execute: (ctx, action) => run(ctx, action),
});
