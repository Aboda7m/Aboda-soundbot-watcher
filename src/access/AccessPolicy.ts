import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * Who may use the bot, and who may do privileged things, decided by Discord user / server ids chosen by the
 * owner. Discord's own "is this person an admin?" is deliberately NOT consulted anywhere: everybody is an
 * administrator of their own server.
 *
 * Two independent switches, both OFF by default (= the bot is global, as before):
 *   whitelist ON  -> the bot only answers in allowed servers, or to allowed users anywhere
 *   blacklist ON  -> blocked servers and blocked users are ignored
 * Owners (from .env) bypass both and can never be blocked, so the owner cannot lock themselves out.
 *
 * Privileged actions need a per-user grant (or ownership):
 *   dashboard        sign in to the web dashboard, see it and play sounds
 *   import           add sounds to the shared library (!import and the dashboard import page)
 *   entrance.manage  set or clear ANOTHER member's entrance sound (!entrance @user ...)
 *   logs             read the dashboard log viewer
 *
 * State lives in one small JSON file that can be edited by hand or by the owner's `!access` command;
 * changes are picked up without a restart.
 */
export const CAPABILITIES = ["dashboard", "import", "entrance.manage", "logs"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const isCapability = (v: string): v is Capability => (CAPABILITIES as readonly string[]).includes(v);

const SNOWFLAKE = /^\d{15,25}$/;

interface PolicyData {
  version: 1;
  whitelistEnabled: boolean;
  blacklistEnabled: boolean;
  allowedGuilds: string[];
  allowedUsers: string[];
  blockedGuilds: string[];
  blockedUsers: string[];
  grants: Record<string, Capability[]>;
}

const emptyData = (): PolicyData => ({
  version: 1,
  whitelistEnabled: false,
  blacklistEnabled: false,
  allowedGuilds: [],
  allowedUsers: [],
  blockedGuilds: [],
  blockedUsers: [],
  grants: {},
});

const idList = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && SNOWFLAKE.test(x))) {
    throw new Error(`${name} must be a list of Discord ids`);
  }
  return [...new Set(v as string[])];
};

function parse(raw: unknown): PolicyData {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("the file must contain a JSON object");
  const r = raw as Record<string, unknown>;
  const d = emptyData();
  for (const key of ["whitelistEnabled", "blacklistEnabled"] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== "boolean") throw new Error(`${key} must be true or false`);
      d[key] = r[key] as boolean;
    }
  }
  for (const key of ["allowedGuilds", "allowedUsers", "blockedGuilds", "blockedUsers"] as const) {
    if (r[key] !== undefined) d[key] = idList(r[key], key);
  }
  if (r.grants !== undefined) {
    if (typeof r.grants !== "object" || r.grants === null || Array.isArray(r.grants)) throw new Error("grants must map a user id to a list of permissions");
    for (const [id, caps] of Object.entries(r.grants)) {
      if (!SNOWFLAKE.test(id)) throw new Error(`grants: "${id}" is not a Discord user id`);
      if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string" && isCapability(c))) {
        throw new Error(`grants.${id} must be a list of: ${CAPABILITIES.join(", ")}`);
      }
      if (caps.length) d.grants[id] = [...new Set(caps as Capability[])];
    }
  }
  return d;
}

export interface AccessPolicyOptions {
  /** Discord user ids with full control (from OWNER_USER_IDS / DASHBOARD_ALLOWED_USER_IDS). */
  owners: string[];
  log?: (msg: string, err?: unknown) => void;
  /** Minimum ms between looks at the file's modification time. */
  reloadCheckMs?: number;
}

export interface AccessSnapshot {
  whitelistEnabled: boolean;
  blacklistEnabled: boolean;
  allowedGuilds: string[];
  allowedUsers: string[];
  blockedGuilds: string[];
  blockedUsers: string[];
  grants: Record<string, Capability[]>;
  owners: string[];
}

export class AccessPolicy {
  #path: string | null;
  #owners: Set<string>;
  #data = emptyData();
  #mtime = -1;
  #lastCheck = 0;
  #log: (msg: string, err?: unknown) => void;
  #reloadCheckMs: number;

  /** `path` null = in memory only (tests). A malformed file throws: it is refused, never silently "fixed". */
  constructor(path: string | null, opts: AccessPolicyOptions) {
    this.#path = path;
    this.#owners = new Set(opts.owners);
    this.#log = opts.log ?? (() => {});
    this.#reloadCheckMs = opts.reloadCheckMs ?? 1000;
    if (path && existsSync(path)) this.#load(true);
  }

  static inMemory(owners: string[] = []): AccessPolicy {
    return new AccessPolicy(null, { owners });
  }

  // ---------------------------------------------------------------- questions

  isOwner(userId: string): boolean {
    return this.#owners.has(userId);
  }

  /** True while the blacklist is on and this user is on it. Owners are never blocked. */
  isBlocked(userId: string): boolean {
    this.#refresh();
    return !this.isOwner(userId) && this.#data.blacklistEnabled && this.#data.blockedUsers.includes(userId);
  }

  /** May the bot react to this user in this server (commands and automatic entrance/exit sounds)? */
  canUseBot(guildId: string, userId: string): boolean {
    this.#refresh();
    if (this.isOwner(userId)) return true;
    const d = this.#data;
    if (d.blacklistEnabled && (d.blockedUsers.includes(userId) || d.blockedGuilds.includes(guildId))) return false;
    if (d.whitelistEnabled && !(d.allowedGuilds.includes(guildId) || d.allowedUsers.includes(userId))) return false;
    return true;
  }

  /** Server-level check for actions with no particular user (dashboard playback targets). */
  guildAllowed(guildId: string): boolean {
    this.#refresh();
    const d = this.#data;
    if (d.blacklistEnabled && d.blockedGuilds.includes(guildId)) return false;
    if (d.whitelistEnabled && !d.allowedGuilds.includes(guildId)) return false;
    return true;
  }

  /** Owners can do everything; everybody else needs the grant, and a blocked user can do nothing. */
  can(userId: string, capability: Capability): boolean {
    this.#refresh();
    if (this.isOwner(userId)) return true;
    if (this.isBlocked(userId)) return false;
    return this.#data.grants[userId]?.includes(capability) ?? false;
  }

  snapshot(): AccessSnapshot {
    this.#refresh();
    const d = this.#data;
    return {
      whitelistEnabled: d.whitelistEnabled,
      blacklistEnabled: d.blacklistEnabled,
      allowedGuilds: [...d.allowedGuilds],
      allowedUsers: [...d.allowedUsers],
      blockedGuilds: [...d.blockedGuilds],
      blockedUsers: [...d.blockedUsers],
      grants: Object.fromEntries(Object.entries(d.grants).map(([k, v]) => [k, [...v]])),
      owners: [...this.#owners],
    };
  }

  // ---------------------------------------------------------------- changes (each one is saved at once)

  setWhitelist(on: boolean): void { this.#change((d) => void (d.whitelistEnabled = on)); }
  setBlacklist(on: boolean): void { this.#change((d) => void (d.blacklistEnabled = on)); }

  allowGuild(id: string): void { this.#edit("allowedGuilds", id, true); }
  unallowGuild(id: string): void { this.#edit("allowedGuilds", id, false); }
  allowUser(id: string): void { this.#edit("allowedUsers", id, true); }
  unallowUser(id: string): void { this.#edit("allowedUsers", id, false); }
  blockGuild(id: string): void { this.#edit("blockedGuilds", id, true); }
  unblockGuild(id: string): void { this.#edit("blockedGuilds", id, false); }

  /** Owners cannot be blocked (it would have no effect and only confuse). Returns false in that case. */
  blockUser(id: string): boolean {
    if (this.isOwner(id)) return false;
    this.#edit("blockedUsers", id, true);
    return true;
  }
  unblockUser(id: string): void { this.#edit("blockedUsers", id, false); }

  grant(userId: string, capability: Capability): void {
    this.#checkId(userId);
    this.#change((d) => {
      const set = new Set(d.grants[userId] ?? []);
      set.add(capability);
      d.grants[userId] = [...set];
    });
  }

  revoke(userId: string, capability: Capability): void {
    this.#checkId(userId);
    this.#change((d) => {
      const left = (d.grants[userId] ?? []).filter((c) => c !== capability);
      if (left.length) d.grants[userId] = left;
      else delete d.grants[userId];
    });
  }

  // ---------------------------------------------------------------- internals

  #checkId(id: string) {
    if (!SNOWFLAKE.test(id)) throw new Error("That is not a valid Discord id.");
  }

  #edit(key: "allowedGuilds" | "allowedUsers" | "blockedGuilds" | "blockedUsers", id: string, add: boolean) {
    this.#checkId(id);
    this.#change((d) => {
      const set = new Set(d[key]);
      if (add) set.add(id);
      else set.delete(id);
      d[key] = [...set];
    });
  }

  #change(mutate: (d: PolicyData) => void) {
    this.#refresh(true);
    const next = structuredClone(this.#data);
    mutate(next);
    this.#data = next;
    this.#save();
  }

  #save() {
    if (!this.#path) return;
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2) + "\n", "utf8");
    renameSync(tmp, this.#path);
    this.#mtime = statSync(this.#path).mtimeMs;
  }

  /** Picks up hand edits. A file that became invalid is reported and ignored: the last good policy stays. */
  #refresh(force = false) {
    if (!this.#path) return;
    const now = Date.now();
    if (!force && now - this.#lastCheck < this.#reloadCheckMs) return;
    this.#lastCheck = now;
    try {
      if (!existsSync(this.#path)) return;
      if (statSync(this.#path).mtimeMs === this.#mtime) return;
      this.#load(false);
    } catch (err) {
      this.#log("Could not re-read the access policy file; keeping the previous rules", err);
    }
  }

  #load(strict: boolean) {
    try {
      const raw = JSON.parse(readFileSync(this.#path!, "utf8"));
      this.#data = parse(raw);
      this.#mtime = statSync(this.#path!).mtimeMs;
    } catch (err) {
      if (strict) throw new Error(`${this.#path}: ${(err as Error).message}`);
      this.#mtime = statSync(this.#path!).mtimeMs; // do not retry the same bad content every second
      this.#log(`${this.#path} is invalid (${(err as Error).message}); keeping the previous rules`);
    }
  }
}
