/**
 * Validation and rendering for `!help` / `!commands`. Pure functions: no discord.js, no I/O.
 *
 * The command list comes from the registry; the wording comes from each command's `help` block (the contract,
 * required and optional fields, is documented on `CommandHelp` in commandTypes.ts). This file never decides who may
 * do what: it only asks each form's `requires.check`, which the command wires to the predicate its own `execute` uses.
 *
 * One rule set, used everywhere (startup warning, owner diagnostics, what regular users see):
 *  - `helpProblems(command)` lists every missing/invalid field; an empty list means "complete";
 *  - regular users only ever see COMPLETE commands, and only the forms they may discover. An incomplete command is
 *    indistinguishable from one that does not exist, in the list and in `!help <command>`;
 *  - the bot owner (`AccessPolicy.isOwner`, the existing owner mechanism) sees EVERY registered command and every
 *    form, plus the exact missing fields of incomplete commands;
 *  - a `check` / `unavailable` that throws counts as "denied" / "no reason", never as "allowed".
 */
import type { CommandRegistry, RegisteredCommand } from "./commandRegistry.ts";
import type { CommandContext, CommandHelp, HelpUsage, TextCommand } from "./commandTypes.ts";
import { chunkLines, MAX_MESSAGE_CHARS } from "./textCommand.ts";

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTextList = (v: unknown, min: number): v is string[] => Array.isArray(v) && v.length >= min && v.every(isText);

/** Replaces `{p}` with the prefix (a function replacer, so `$` in a prefix is not special). */
const fill = (text: string, prefix: string): string => text.replaceAll("{p}", () => prefix);

/**
 * Every missing or invalid help field of `command`, as paths (`help.usages[1].examples`). Empty = complete.
 * This is the only definition of "complete"; see CommandHelp for which fields are required and which are optional.
 */
export function helpProblems(command: TextCommand<unknown>): string[] {
  const help: unknown = (command as { help?: unknown }).help;
  if (help === undefined) return ["help"];
  if (!isObject(help)) return ["help (must be an object)"];

  const out: string[] = [];
  if (!isText(help.summary)) out.push("help.summary");
  if (help.synopsis !== undefined && !isText(help.synopsis)) out.push("help.synopsis");
  if (help.notes !== undefined && !isTextList(help.notes, 0)) out.push("help.notes");

  if (!Array.isArray(help.usages) || help.usages.length === 0) {
    out.push("help.usages");
    return out;
  }
  help.usages.forEach((u: unknown, i) => {
    const at = `help.usages[${i}]`;
    if (!isObject(u)) return void out.push(at);
    if (!isText(u.usage)) out.push(`${at}.usage`);
    if (!isText(u.summary)) out.push(`${at}.summary`);
    if (!isTextList(u.examples, 1)) out.push(`${at}.examples`);
    if (u.unavailable !== undefined && typeof u.unavailable !== "function") out.push(`${at}.unavailable`);
    if (u.requires !== undefined) {
      const r = u.requires;
      if (!isObject(r)) return void out.push(`${at}.requires`);
      if (!isText(r.label)) out.push(`${at}.requires.label`);
      if (typeof r.check !== "function") out.push(`${at}.requires.check`);
      if (r.discoverable !== undefined && typeof r.discoverable !== "boolean") out.push(`${at}.requires.discoverable`);
    }
  });
  return out;
}

const labelOf = ({ command }: RegisteredCommand, prefix: string): string => {
  const [name, ...aliases] = command.names;
  return `${prefix}${name}${aliases.length ? ` (aliases: ${aliases.map((a) => `${prefix}${a}`).join(", ")})` : ""}`;
};

/**
 * The one startup warning: every command whose help is incomplete, with its aliases and the exact fields.
 * Null when everything is complete.
 */
export function formatHelpWarning(registry: CommandRegistry, prefix: string): string | null {
  const bad = registry.commands.map((entry) => ({ entry, problems: helpProblems(entry.command) })).filter((b) => b.problems.length > 0);
  if (bad.length === 0) return null;
  return [
    `Help metadata is incomplete for ${bad.length} of ${registry.commands.length} command(s). They work normally, but regular users cannot see them in ${prefix}help (owners can, with these details):`,
    ...bad.map(({ entry, problems }) => `  - ${labelOf(entry, prefix)}: missing or invalid ${problems.join(", ")}`),
  ].join("\n");
}

const isOwner = (ctx: CommandContext): boolean => ctx.deps.access.isOwner(ctx.message.author.id);

interface ResolvedUsage {
  usage: HelpUsage;
  locked: boolean;
  lockLabel: string;
  unavailable: string | undefined;
}

/** The forms of a COMPLETE `help` that this viewer may see, in declared order. Owners see all of them. */
function resolveUsages(help: CommandHelp, ctx: CommandContext, owner: boolean): ResolvedUsage[] {
  const out: ResolvedUsage[] = [];
  for (const u of help.usages) {
    let allowed = true;
    const req = u.requires;
    if (req) {
      try {
        allowed = req.check(ctx) === true;
      } catch {
        allowed = false;
      }
      if (!allowed && req.discoverable !== true && !owner) continue; // hidden from people who cannot use it
    }
    let unavailable: string | undefined;
    if (allowed && u.unavailable) {
      try {
        const reason = u.unavailable(ctx);
        unavailable = isText(reason) ? reason : undefined;
      } catch {
        unavailable = undefined;
      }
    }
    out.push({ usage: u, locked: !allowed, lockLabel: req?.label ?? "restricted", unavailable });
  }
  return out;
}

const aliasText = (names: readonly string[], prefix: string): string =>
  names.length > 1 ? names.slice(1).map((n) => `\`${prefix}${n}\``).join(", ") : "";

/** `!help`: every command the viewer may discover, one line each (owners: every registered command). */
export function formatOverview(registry: CommandRegistry, ctx: CommandContext): string[] {
  const p = ctx.deps.prefix;
  const owner = isOwner(ctx);
  const lines: string[] = [];
  let anyLocked = false;
  let anyIncomplete = false;
  let example: string | undefined; // first fully documented command the viewer can see, so the footer never names a hidden one

  for (const entry of registry.commands) {
    const { command } = entry;
    const aliases = aliasText(command.names, p);
    const also = aliases ? ` (also ${aliases})` : "";
    const problems = helpProblems(command);

    if (problems.length > 0) {
      if (!owner) continue; // exactly like a command that does not exist
      anyIncomplete = true;
      lines.push(`⚠️ \`${p}${command.names[0]}\`${also} - help incomplete, missing: ${problems.map((x) => `\`${x}\``).join(", ")}`);
      continue;
    }

    const help = (command as { help: CommandHelp }).help;
    const usages = resolveUsages(help, ctx, owner);
    if (usages.length === 0) continue;
    const allLocked = usages.every((u) => u.locked);
    anyLocked ||= allLocked;
    example ??= command.names[0];
    const synopsis = fill(help.synopsis ?? `{p}${command.names[0]}`, p);
    lines.push(`${allLocked ? "🔒 " : ""}\`${synopsis}\` - ${fill(help.summary, p)}${also}`);
  }

  if (lines.length === 0) return ["No help is available right now."];

  const footer = [`\nUse \`${p}help <command>\` for usage and examples, e.g. \`${p}help ${example ?? "help"}\`.`];
  if (anyLocked) footer.push("🔒 = you need a permission you don't currently have.");
  if (anyIncomplete) footer.push("⚠️ = help metadata missing or invalid. Only bot owners see these commands here.");
  return chunkLines([...lines, ...footer], MAX_MESSAGE_CHARS, `**Commands** (prefix \`${p}\`)\n`);
}

/** `!help <command>`: usage, examples and notes for one command, or a "not found" line. */
export function formatDetail(registry: CommandRegistry, topic: string, ctx: CommandContext): string[] {
  const p = ctx.deps.prefix;
  const owner = isOwner(ctx);
  const entry = registry.lookup(topic);
  const problems = entry ? helpProblems(entry.command) : [];
  const usages = entry && problems.length === 0 ? resolveUsages((entry.command as { help: CommandHelp }).help, ctx, owner) : [];

  // Unknown, incomplete and hidden commands all get the same answer to a regular user, so this cannot be used to probe for them.
  const diagnostic = entry !== undefined && owner && problems.length > 0;
  if (!entry || (usages.length === 0 && !diagnostic)) {
    const shown = topic.replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 32);
    return [`No help for ${shown ? `\`${shown}\`` : "that"}. See \`${p}help\` for the commands you can use.`];
  }

  const { command } = entry;
  const aliases = aliasText(command.names, p);

  if (diagnostic) {
    return chunkLines(
      [
        `⚠️ Help metadata is incomplete, so regular users cannot see this command in \`${p}help\`. Only you can.`,
        ...(aliases ? [`Also: ${aliases}`] : []),
        `Registered description: ${command.description}`,
        "Missing or invalid fields:",
        ...problems.map((x) => `• \`${x}\``),
      ],
      MAX_MESSAGE_CHARS,
      `**${p}${command.names[0]}**\n`,
    );
  }

  const help = (command as { help: CommandHelp }).help;
  const lines: string[] = [fill(help.summary, p)];
  if (aliases) lines.push(`Also: ${aliases}`);
  lines.push("");

  for (const r of usages) {
    const head = `${r.locked ? "🔒 " : ""}\`${fill(r.usage.usage, p)}\` - ${fill(r.usage.summary, p)}`;
    lines.push(r.locked ? `${head} (${r.lockLabel})` : head);
    if (r.unavailable) lines.push(`   ⚠️ unavailable right now: ${fill(r.unavailable, p)}`);
    if (!r.locked) lines.push(`   e.g. ${r.usage.examples.map((e) => `\`${fill(e, p)}\``).join("  ")}`);
  }

  // Notes may describe behavior the viewer cannot use, so they are only shown to someone who can run a form.
  if (help.notes?.length && usages.some((u) => !u.locked)) {
    lines.push("", ...help.notes.map((n) => `• ${fill(n, p)}`));
  }

  return chunkLines(lines, MAX_MESSAGE_CHARS, `**${p}${command.names[0]}**\n`);
}
