import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { SoundRepository } from "../sound/SoundRepository.ts";
import { PermissionFlagsBits, type Client, type Guild, type GuildMember } from "discord.js";
import { SECURITY_HEADERS, SNOWFLAKE, json, readBody } from "./common.ts";
import { mayAdministerGuild } from "./entranceAdminAuth.ts";

/**
 * "My entrance sound" API. Public listener only: it needs a Discord identity, and the local listener has none.
 *
 * Whose entrance sound is read or changed is ALWAYS the signed-in Discord account of the session (`kit.user`).
 * No request field names a user, so there is nothing to tamper with. Authentication, the dashboard permission and
 * the Origin / content-type check for POSTs happen before this file is reached.
 *
 *   GET  /api/entrance                  { user, sound, exists }   the caller's current entrance sound
 *   GET  /api/entrance/preview?sound=   the sound file, so the page can play it in the browser
 *   POST /api/entrance                  { sound }                 set it
 *   POST /api/entrance/clear                                      remove it
 */
export interface EntranceDeps {
  library: Pick<SoundLibrary, "has" | "resolve">;
  repo: Pick<SoundRepository, "entrance" | "setEntrance" | "clearEntrance" | "setGuildEntrance" | "clearGuildEntrance" | "hasGuildEntranceOverride" | "guildEntranceAssignment" | "releaseGuildEntrance" | "userGuildEntrance" | "setUserGuildEntrance" | "userEntranceDuration" | "setUserEntranceDuration" | "guildEntranceSettings" | "setGuildEntranceSettings" | "userEntranceTiming" | "setUserEntranceTiming">;
  accessibleGuildIds?: (userId: string) => Promise<readonly string[]>;
  client?: Client;
  /** Bot-level grant; unlike Discord guild permissions, this capability intentionally applies to all bot guilds. */
  canManageEntrances?: (userId: string) => boolean;
}

export interface EntranceKit {
  user: { id: string; username: string };
  guard(req: IncomingMessage, res: ServerResponse, contentType?: string): boolean;
}

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

export async function resolveAdminGuild(
  client: Client, userId: string, guildId: string, hasBotEntranceGrant = false,
): Promise<Guild | null> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild || !guild.available) return null;
  if (hasBotEntranceGrant || guild.ownerId === userId) return guild;
  try {
    const member = await guild.members.fetch({ user: userId, force: true });
    return mayAdministerGuild(userId, guild.ownerId, {
      hasAdministrator: member.permissions.has(PermissionFlagsBits.Administrator),
      hasManageGuild: member.permissions.has(PermissionFlagsBits.ManageGuild),
    }) ? guild : null;
  } catch {
    return null;
  }
}

export async function canAdministerAnyGuild(
  client: Client, userId: string, hasBotEntranceGrant = false,
): Promise<boolean> {
  for (const guild of client.guilds.cache.values()) if (await resolveAdminGuild(client, userId, guild.id, hasBotEntranceGrant)) return true;
  return false;
}

async function handleAdminRoute(
  d: EntranceDeps, req: IncomingMessage, res: ServerResponse, url: URL, kit: EntranceKit,
): Promise<boolean> {
  const { pathname } = url;
  const isGet = req.method === "GET";
  const isPost = req.method === "POST";
  const known = (isGet && (pathname === "/api/entrance/admin/guilds" || pathname === "/api/entrance/admin/members")) ||
    (isGet && pathname === "/api/entrance/admin/policy") ||
    (isPost && (pathname === "/api/entrance/admin/assign" || pathname === "/api/entrance/admin/clear" || pathname === "/api/entrance/admin/release" || pathname === "/api/entrance/admin/policy"));
  if (!known) return false;
  if (!d.client) { json(res, 503, { error: "Entrance administration is unavailable" }); return true; }

  const hasBotEntranceGrant = d.canManageEntrances?.(kit.user.id) === true;

  if (isGet && pathname === "/api/entrance/admin/guilds") {
    const guilds = [];
    for (const guild of d.client.guilds.cache.values()) {
      if (await resolveAdminGuild(d.client, kit.user.id, guild.id, hasBotEntranceGrant)) guilds.push({ id: guild.id, name: guild.name });
    }
    if (!guilds.length) { json(res, 403, { error: "You do not administer any server where the bot is present" }); return true; }
    json(res, 200, { guilds });
    return true;
  }

  if (isGet && pathname === "/api/entrance/admin/policy") {
    const guildId = url.searchParams.get("guildId") ?? "";
    const guild = await resolveAdminGuild(d.client, kit.user.id, guildId, hasBotEntranceGrant);
    if (!guild) { json(res, 403, { error: "You cannot administer this server" }); return true; }
    json(res, 200, { guildId, policy: d.repo.guildEntranceSettings(guildId) }); return true;
  }

  if (isGet) {
    const guildId = url.searchParams.get("guildId") ?? "";
    const guild = await resolveAdminGuild(d.client, kit.user.id, guildId, hasBotEntranceGrant);
    if (!guild) { json(res, 403, { error: "You cannot administer this server" }); return true; }
    try {
      // Listing all members requires the privileged Guild Members intent, enabled in createClient().
      const members = await guild.members.fetch();
      json(res, 200, { guild: { id: guild.id, name: guild.name }, members: [...members.values()]
        .filter((m) => !m.user.bot)
        .map((m) => {
          const sound = d.repo.entrance(m.id, guild.id) ?? null;
          return {
            id: m.id, username: m.user.username, displayName: m.displayName, sound,
            exists: sound ? d.library.has(sound) : false,
            guildOverride: d.repo.hasGuildEntranceOverride(m.id, guild.id),
          };
        }).sort((a, b) => a.displayName.localeCompare(b.displayName)) });
    } catch {
      json(res, 503, { error: "Could not load server members. Check the bot's Guild Members intent." });
    }
    return true;
  }

  if (!kit.guard(req, res)) return true;
  let body: { guildId?: unknown; userId?: unknown; sound?: unknown };
  try { body = JSON.parse(await readBody(req)); }
  catch { json(res, 400, { error: "Body must be valid JSON under 2 KB" }); return true; }
  const guildId = body?.guildId;
  const userId = body?.userId;
  if (typeof guildId !== "string" || !SNOWFLAKE.test(guildId)) { json(res, 400, { error: "guildId must be a Discord ID" }); return true; }
  const guild = await resolveAdminGuild(d.client, kit.user.id, guildId, hasBotEntranceGrant);
  if (!guild) { json(res, 403, { error: "You cannot administer this server" }); return true; }
  if (pathname === "/api/entrance/admin/policy") {
    const allowed = ["enabled", "maxDurationSec", "reconnectGraceSec", "minReconnectGraceSec", "userCooldownSec", "enforcedUserCooldownSec", "guildCooldownSec", "allowUserTiming"];
    const patch: Record<string, unknown> = {};
    for (const key of allowed) if (Object.hasOwn(body, key)) patch[key] = (body as Record<string, unknown>)[key];
    if (!Object.keys(patch).length) { json(res, 400, { error: "At least one policy setting is required" }); return true; }
    try { d.repo.setGuildEntranceSettings(guild.id, patch); json(res, 200, { ok: true, policy: d.repo.guildEntranceSettings(guild.id) }); }
    catch (e) { json(res, 400, { error: (e as Error).message }); }
    return true;
  }
  if (typeof userId !== "string" || !SNOWFLAKE.test(userId)) { json(res, 400, { error: "userId must be a Discord ID" }); return true; }
  let member: GuildMember;
  try { member = await guild.members.fetch({ user: userId, force: true }); }
  catch { json(res, 404, { error: "That user is not a member of this server" }); return true; }
  if (member.user.bot) { json(res, 400, { error: "Bot accounts cannot be assigned entrance sounds" }); return true; }

  if (pathname === "/api/entrance/admin/release") {
    d.repo.releaseGuildEntrance(guild.id, member.id);
    json(res, 200, { ok: true });
    return true;
  }
  if (pathname === "/api/entrance/admin/clear") {
    d.repo.clearGuildEntrance(guild.id, member.id);
    json(res, 200, { ok: true });
    return true;
  }
  const sound = body.sound;
  if (typeof sound !== "string" || !sound || sound.length > 200) { json(res, 400, { error: "sound must be a sound name" }); return true; }
  if (!d.library.has(sound)) { json(res, 404, { error: "Unknown sound" }); return true; }
  d.repo.setGuildEntrance(guild.id, member.id, sound);
  json(res, 200, { ok: true, sound });
  return true;
}

/** Returns true if the request was one of ours (and has been answered). */
export async function handleEntranceRoute(
  d: EntranceDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kit: EntranceKit,
): Promise<boolean> {
  if (await handleAdminRoute(d, req, res, url, kit)) return true;
  const { pathname } = url;
  const isGet = req.method === "GET";
  const isPost = req.method === "POST";

  const known =
    (isGet && ["/api/entrance", "/api/entrance/preview", "/api/entrance/settings"].includes(pathname)) ||
    (isPost && ["/api/entrance", "/api/entrance/clear", "/api/entrance/preferences", "/api/entrance/duration", "/api/entrance/timing"].includes(pathname));
  if (!known) return false;

  const uid = kit.user.id;
  if (!SNOWFLAKE.test(uid)) {
    json(res, 403, { error: "Entrance sounds need a Discord sign-in" });
    return true;
  }

  if (isGet && pathname === "/api/entrance") {
    const sound = d.repo.entrance(uid) ?? null;
    json(res, 200, {
      user: { id: uid, username: kit.user.username },
      sound,
      exists: sound === null ? false : d.library.has(sound),
    });
    return true;
  }

  if (isGet && pathname === "/api/entrance/settings") {
    const guildId = url.searchParams.get("guildId") ?? "";
    if (!SNOWFLAKE.test(guildId)) { json(res, 400, { error: "guildId must be a Discord ID" }); return true; }
    if (!d.accessibleGuildIds) { json(res, 503, { error: "Guild access information unavailable" }); return true; }
    let allowed: readonly string[]; try { allowed = await d.accessibleGuildIds(uid); } catch { json(res, 503, { error: "Could not verify guild access" }); return true; }
    if (!allowed.includes(guildId)) { json(res, 403, { error: "You cannot access this server" }); return true; }
    const guildPref = d.repo.userGuildEntrance(uid, guildId);
    const globalSound = d.repo.entrance(uid);
    const policy = d.repo.guildEntranceSettings(guildId);
    const duration = d.repo.userEntranceDuration(uid, guildId);
    json(res, 200, { guildId, mode: guildPref === undefined ? "inherit" : guildPref === "" ? "disabled" : "sound", guildSound: guildPref || null, globalSound: globalSound ?? null, durationSec: duration ?? null, timing: d.repo.userEntranceTiming(uid, guildId), policy, effectiveSound: policy.enabled === false ? null : d.repo.guildEntranceAssignment(uid, guildId) !== undefined ? (d.repo.guildEntranceAssignment(uid, guildId) || null) : guildPref !== undefined ? (guildPref || null) : (globalSound ?? null) });
    return true;
  }

  if (isGet) {
    // Names are looked up in the library's directory scan, never joined onto a path, so "../x" is simply unknown.
    const file = d.library.resolve(url.searchParams.get("sound") ?? "");
    let size = -1;
    try {
      if (file) size = statSync(file).size;
    } catch {
      // vanished since the last scan
    }
    if (!file || size < 0) {
      json(res, 404, { error: "Unknown sound" });
      return true;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": size,
    });
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
    return true;
  }

  if (!kit.guard(req, res)) return true;

  if (["/api/entrance/preferences", "/api/entrance/duration", "/api/entrance/timing"].includes(pathname)) {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { json(res, 400, { error: "Body must be valid JSON under 2 KB" }); return true; }
    const guildId = body.guildId;
    if (guildId !== undefined) {
      if (typeof guildId !== "string" || !SNOWFLAKE.test(guildId)) { json(res, 400, { error: "guildId must be a Discord ID" }); return true; }
      if (!d.accessibleGuildIds) { json(res, 503, { error: "Guild access information unavailable" }); return true; }
      let allowed: readonly string[]; try { allowed = await d.accessibleGuildIds(uid); } catch { json(res, 503, { error: "Could not verify guild access" }); return true; }
      if (!allowed.includes(guildId)) { json(res, 403, { error: "You cannot access this server" }); return true; }
    }
    try {
      if (pathname === "/api/entrance/preferences") {
        if (!guildId || !["inherit", "sound", "disabled"].includes(String(body.mode))) throw new Error("guildId and mode inherit|sound|disabled are required");
        const mode = body.mode;
        if (mode === "sound") { if (typeof body.sound !== "string" || !d.library.has(body.sound)) throw new Error("Unknown sound"); d.repo.setUserGuildEntrance(uid, guildId as string, body.sound); }
        else if (mode === "disabled") d.repo.setUserGuildEntrance(uid, guildId as string, "");
        else d.repo.setUserGuildEntrance(uid, guildId as string, null);
      } else if (pathname === "/api/entrance/duration") {
        const seconds = body.durationSec;
        if (seconds !== null && (!Number.isInteger(seconds) || (seconds as number) < 1 || (seconds as number) > 30)) throw new Error("durationSec must be null or an integer from 1 to 30");
        d.repo.setUserEntranceDuration(uid, seconds as number | null, typeof guildId === "string" ? guildId : undefined);
      } else {
        const patch: { cooldownSec?: number | null; reconnectGraceSec?: number | null } = {};
        for (const key of ["cooldownSec", "reconnectGraceSec"] as const) if (Object.hasOwn(body, key)) { const v = body[key]; if (v !== null && (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 86400)) throw new Error(`${key} must be null or integer seconds from 0 to 86400`); patch[key] = v as number | null; }
        if (!Object.keys(patch).length) throw new Error("At least one timing setting is required");
        if (typeof guildId === "string" && d.repo.guildEntranceSettings(guildId).allowUserTiming === false) throw new Error("User timing customization is disabled for this server");
        d.repo.setUserEntranceTiming(uid, patch, typeof guildId === "string" ? guildId : undefined);
      }
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: (e as Error).message }); }
    return true;
  }

  if (pathname === "/api/entrance/clear") {
    d.repo.clearEntrance(uid);
    json(res, 200, { ok: true });
    return true;
  }

  let body: { sound?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Body must be valid JSON under 2 KB" });
    return true;
  }
  const sound = body?.sound;
  if (typeof sound !== "string" || sound.length === 0 || sound.length > 200) {
    json(res, 400, { error: "sound must be a sound name" });
    return true;
  }
  if (!d.library.has(sound)) {
    json(res, 404, { error: "Unknown sound" });
    return true;
  }
  if (d.repo.entrance(uid) !== sound) d.repo.setEntrance(uid, sound); // unchanged = no disk write
  json(res, 200, { ok: true, sound });
  return true;
}
