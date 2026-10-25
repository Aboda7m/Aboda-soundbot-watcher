import { CAPABILITIES, isCapability, type AccessPolicy } from "../../access/AccessPolicy.ts";
import { defineTextCommand, type CommandContext } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";

/**
 * Owner-only control of who may use the bot. Owners are Discord user ids from the server's .env, never
 * Discord roles or permissions, so nobody can become an owner by being an administrator of some server.
 * Everyone else gets no reply at all (the command does not reveal that it exists).
 */
const USER = /^<@!?(\d{15,25})>$|^(\d{15,25})$/;
const SERVER = /^\d{15,25}$/;

const userId = (token: string | undefined): string | null => {
  const m = token ? USER.exec(token) : null;
  return m ? (m[1] ?? m[2] ?? null) : null;
};

const USAGE = (p: string) =>
  [
    "**Access control** (bot owners only)",
    `\`${p}access\` shows the current settings, \`${p}access list\` DMs you every id.`,
    `\`${p}access whitelist on|off\`: when on, only allowed servers (or allowed users anywhere) can use the bot.`,
    `\`${p}access blacklist on|off\`: when on, blocked servers and users are ignored.`,
    `\`${p}access allow|unallow server <id|here>\` and \`${p}access allow|unallow user <@user|id>\``,
    `\`${p}access block|unblock server <id|here>\` and \`${p}access block|unblock user <@user|id>\``,
    `\`${p}access grant|revoke <@user|id> <${CAPABILITIES.join("|")}>\``,
  ].join("\n");

function status(a: AccessPolicy): string {
  const s = a.snapshot();
  return [
    "**Access settings**",
    `• Whitelist: **${s.whitelistEnabled ? "ON" : "off"}**${s.whitelistEnabled ? ` (${s.allowedGuilds.length} servers, ${s.allowedUsers.length} users allowed)` : " (bot works everywhere)"}`,
    `• Blacklist: **${s.blacklistEnabled ? "ON" : "off"}** (${s.blockedGuilds.length} servers, ${s.blockedUsers.length} users listed${s.blacklistEnabled ? "" : ", not enforced"})`,
    `• Users with extra permissions: ${Object.keys(s.grants).length}`,
    `• Owners: ${s.owners.length}`,
  ].join("\n");
}

function listing(a: AccessPolicy): string {
  const s = a.snapshot();
  const u = (ids: string[]) => (ids.length ? ids.map((i) => `<@${i}> (${i})`).join(", ") : "none");
  const g = (ids: string[]) => (ids.length ? ids.join(", ") : "none");
  const grants = Object.entries(s.grants).map(([id, caps]) => `  <@${id}> (${id}): ${caps.join(", ")}`);
  return [
    status(a),
    `Allowed servers: ${g(s.allowedGuilds)}`,
    `Allowed users: ${u(s.allowedUsers)}`,
    `Blocked servers: ${g(s.blockedGuilds)}`,
    `Blocked users: ${u(s.blockedUsers)}`,
    `Permissions:${grants.length ? "\n" + grants.join("\n") : " none"}`,
  ].join("\n");
}

async function run({ message, guildId, deps }: CommandContext, args: string[]): Promise<void> {
  const access = deps.access;
  const p = deps.prefix;
  if (!access.isOwner(message.author.id)) return; // silent for everyone else

  const sub = args[0]?.toLowerCase();
  const reply = (text: string) => say(message, text);

  try {
    if (!sub || sub === "status") return void (await reply(status(access)));

    if (sub === "list") {
      try {
        await message.author.send(listing(access));
        await reply("Sent you a DM with the full list.");
      } catch {
        await reply("I couldn't DM you. Open your DMs for this server and try again.");
      }
      return;
    }

    if (sub === "whitelist" || sub === "blacklist") {
      const v = args[1]?.toLowerCase();
      if (v !== "on" && v !== "off") return void (await reply(`Use \`${p}access ${sub} on\` or \`${p}access ${sub} off\`.`));
      const on = v === "on";
      if (sub === "whitelist") access.setWhitelist(on);
      else access.setBlacklist(on);
      const s = access.snapshot();
      let text = `${sub === "whitelist" ? "Whitelist" : "Blacklist"} is now **${on ? "ON" : "off"}**.`;
      if (sub === "whitelist" && on && s.allowedGuilds.length === 0 && s.allowedUsers.length === 0) {
        text += ` Nobody except owners can use the bot until you allow a server (\`${p}access allow server here\`) or a user.`;
      }
      return void (await reply(text));
    }

    if (sub === "allow" || sub === "unallow" || sub === "block" || sub === "unblock") {
      const kind = args[1]?.toLowerCase();
      const target = args[2];
      const add = sub === "allow" || sub === "block";
      if (kind === "server") {
        const id = target?.toLowerCase() === "here" ? guildId : target && SERVER.test(target) ? target : null;
        if (!id) return void (await reply(`Give a server id, or \`here\`: \`${p}access ${sub} server <id|here>\`.`));
        if (sub === "allow") access.allowGuild(id);
        else if (sub === "unallow") access.unallowGuild(id);
        else if (sub === "block") access.blockGuild(id);
        else access.unblockGuild(id);
        return void (await reply(`Server ${id} ${add ? (sub === "allow" ? "is now allowed" : "is now blocked") : sub === "unallow" ? "is no longer on the allow list" : "is no longer blocked"}.`));
      }
      if (kind === "user") {
        const id = userId(target);
        if (!id) return void (await reply(`Mention the user or give their id: \`${p}access ${sub} user <@user|id>\`.`));
        if (sub === "allow") access.allowUser(id);
        else if (sub === "unallow") access.unallowUser(id);
        else if (sub === "unblock") access.unblockUser(id);
        else if (!access.blockUser(id)) return void (await reply("Owners cannot be blocked."));
        return void (await reply(`User <@${id}> ${add ? (sub === "allow" ? "is now allowed" : "is now blocked") : sub === "unallow" ? "is no longer on the allow list" : "is no longer blocked"}.`));
      }
      return void (await reply(`Say \`server\` or \`user\`: \`${p}access ${sub} server|user <id>\`.`));
    }

    if (sub === "grant" || sub === "revoke") {
      const id = userId(args[1]);
      const cap = args[2]?.toLowerCase();
      if (!id || !cap || !isCapability(cap)) {
        return void (await reply(`Usage: \`${p}access ${sub} <@user|id> <${CAPABILITIES.join("|")}>\`.`));
      }
      if (sub === "grant") access.grant(id, cap);
      else access.revoke(id, cap);
      return void (await reply(`<@${id}> ${sub === "grant" ? "now has" : "no longer has"} **${cap}**.`));
    }

    await reply(USAGE(p));
  } catch (err) {
    await reply(`That didn't work: ${(err as Error).message}`);
  }
}

export default defineTextCommand({
  names: ["access"],
  description: "Owner only: control who may use the bot (whitelist/blacklist) and who has extra permissions",
  parse: (content, prefix) => {
    const text = content.trim();
    const head = `${prefix}access`;
    if (!text.toLowerCase().startsWith(head.toLowerCase())) return null;
    const rest = text.slice(head.length);
    if (rest !== "" && !/^\s/.test(rest)) return null;
    return { args: rest.trim().split(/\s+/).filter(Boolean) };
  },
  execute: (ctx, parsed) => run(ctx, parsed.args),
});
