import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { AccessPolicy, ADMIN_CAPABILITIES, CAPABILITIES, isCapability, type Capability } from "../access/AccessPolicy.ts";
import type { SessionStore } from "./auth/sessions.ts";
import { json, readBody, SNOWFLAKE } from "./common.ts";

export interface AccessRoutesDeps {
  access: AccessPolicy;
  sessions: SessionStore;
  client?: Client;
  can(userId: string, capability: Capability): boolean;
}

export interface AccessRouteKit {
  user: { id: string; username: string };
  guard(req: IncomingMessage, res: ServerResponse, contentType?: string): boolean;
}

export const USER_CAPABILITIES = CAPABILITIES;

function roleOf(caps: readonly Capability[]): "user" | "admin" | "custom" {
  const normalized = [...new Set(caps)].sort();
  if (normalized.length === 1 && normalized[0] === "dashboard") return "user";
  if (normalized.length === ADMIN_CAPABILITIES.length && ADMIN_CAPABILITIES.every((c) => normalized.includes(c))) return "admin";
  return normalized.length ? "custom" : "user";
}

function knownUsers(d: AccessRoutesDeps) {
  const snap = d.access.snapshot();
  const sessions = d.sessions.all();
  const ids = new Set<string>([
    ...Object.keys(snap.grants), ...snap.dashboardUsers, ...snap.owners,
    ...snap.allowedUsers, ...snap.blockedUsers, ...sessions.map((s) => s.user.id),
  ]);
  const sessionNames = new Map(sessions.map((s) => [s.user.id, s.user.username]));
  return [...ids].sort().map((id) => {
    const caps = d.access.capabilitiesFor(id);
    const discordUser = d.client?.users.cache.get(id);
    return {
      id,
      username: discordUser?.username ?? sessionNames.get(id) ?? "Unknown Discord user",
      globalName: discordUser?.globalName ?? null,
      owner: d.access.isOwner(id),
      blocked: d.access.isBlocked(id),
      capabilities: caps,
      role: d.access.isOwner(id) ? "owner" : roleOf(caps),
    };
  });
}

/** Owner or explicitly delegated access managers can manage bot grants. Discord guild roles are unrelated. */
export async function handleAccessRoute(
  d: AccessRoutesDeps, req: IncomingMessage, res: ServerResponse, url: URL, kit: AccessRouteKit,
): Promise<boolean> {
  const path = url.pathname;
  const get = req.method === "GET";
  const post = req.method === "POST";
  if (!(get && path === "/api/access/users") && !(post && path === "/api/access/users/update")) return false;
  if (!d.can(kit.user.id, "access.manage")) {
    json(res, 403, { error: "You do not have permission to manage bot users" });
    return true;
  }
  if (get) {
    const actorCaps = d.access.capabilitiesFor(kit.user.id);
    const users = knownUsers(d).map((user) => ({
      ...user,
      // Delegated managers can edit only users whose entire current grant set is within their own authority.
      editable: !user.owner && user.id !== kit.user.id &&
        (d.access.isOwner(kit.user.id) || user.capabilities.every((c) => actorCaps.includes(c))),
    }));
    json(res, 200, { users, capabilities: CAPABILITIES, adminCapabilities: ADMIN_CAPABILITIES, owner: d.access.isOwner(kit.user.id) });
    return true;
  }
  if (!kit.guard(req, res)) return true;
  let body: { userId?: unknown; role?: unknown; capabilities?: unknown };
  try { body = JSON.parse(await readBody(req)); }
  catch { json(res, 400, { error: "Body must be valid JSON under 2 KB" }); return true; }
  const targetId = body?.userId;
  if (typeof targetId !== "string" || !SNOWFLAKE.test(targetId)) {
    json(res, 400, { error: "userId must be a valid Discord ID" }); return true;
  }
  if (d.access.isOwner(targetId)) { json(res, 403, { error: "Bot owner permissions are configured outside this page and cannot be changed here" }); return true; }
  if (targetId === kit.user.id) { json(res, 403, { error: "You cannot change your own permissions" }); return true; }

  let capabilities: Capability[];
  if (body.role === "user") capabilities = ["dashboard"];
  else if (body.role === "admin") capabilities = [...ADMIN_CAPABILITIES];
  else if (body.role === "custom" && Array.isArray(body.capabilities) && body.capabilities.every((c) => typeof c === "string" && isCapability(c))) {
    capabilities = [...new Set(body.capabilities as Capability[])];
  } else {
    json(res, 400, { error: "Choose user, admin, or custom with valid capabilities" }); return true;
  }

  if (!d.access.isOwner(kit.user.id)) {
    const actorCaps = new Set(d.access.capabilitiesFor(kit.user.id));
    if (capabilities.some((cap) => !actorCaps.has(cap))) {
      json(res, 403, { error: "You may only grant permissions that you already have" }); return true;
    }
    if (body.role === "admin" && ADMIN_CAPABILITIES.some((cap) => !actorCaps.has(cap))) {
      json(res, 403, { error: "You do not have every permission required to grant the Bot Admin preset" }); return true;
    }
  }

  try {
    d.access.setCapabilities(targetId, capabilities);
    json(res, 200, { ok: true, userId: targetId, role: roleOf(capabilities), capabilities });
  } catch (err) {
    json(res, 400, { error: (err as Error).message || "Could not update permissions" });
  }
  return true;
}
