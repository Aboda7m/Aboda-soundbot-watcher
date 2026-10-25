import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Who may use the bot, and who may do privileged things, decided by Discord user / server ids chosen by the
 * owner. Discord's own "is this person an admin?" is deliberately NOT consulted anywhere: everybody is an
 * administrator of their own server.
 *
 * Two independent switches, both OFF by default (= the bot is open to every user and server, no id has to be listed):
 *   whitelist ON  -> the bot only answers in allowed servers, or to allowed users anywhere
 *   blacklist ON  -> blocked servers and blocked users are ignored
 * The id lists never restrict anything by themselves: an empty or missing list does not turn whitelist mode on.
 * Owners (OWNER_USER_IDS in .env, never this file) bypass both and can never be blocked, so the owner cannot lock
 * themselves out. Owners are a separate concept from the per-user grants below.
 *
 * Privileged actions need a per-user grant (or ownership):
 *   dashboard        sign in to the web dashboard, see it and play sounds
 *   import           add sounds to the shared library (!import and the dashboard import page)
 *   entrance.manage  set or clear ANOTHER member's entrance sound (!entrance @user ...)
 *   logs             read the dashboard log viewer
 *
 * State lives in one small JSON file (created with the open defaults when it is missing) that can be edited by hand or
 * by the owner's `!access` command; changes are picked up without a restart. A file that is not valid is never
 * overwritten or "repaired": at startup it is refused, while running the last good rules stay in force and changes
 * are refused until the file is fixed.
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

/** The open default: nothing enforced, nothing listed, nobody granted. This is also what a new access.json contains. */
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

const serialize = (d: PolicyData) => JSON.stringify(d, null, 2) + "\n";

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
  /** Discord user ids with full control (OWNER_USER_IDS). Never read from the access file. */
  owners: string[];
  /**
   * Legacy DASHBOARD_ALLOWED_USER_IDS: these users keep the `dashboard` permission (sign in, view, play) and nothing
   * else. They are NOT owners and are not written to the access file; remove them from .env to remove the access.
   */
  dashboardUsers?: string[];
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
  /** Env-configured dashboard-only users (legacy DASHBOARD_ALLOWED_USER_IDS), separate from owners and from grants. */
  dashboardUsers: string[];
}

export class AccessPolicy {
  #path: string | null;
  #owners: Set<string>;
  #dashboardUsers: Set<string>;
  #data = emptyData();
  /** Why the file on disk is currently unusable (null = fine). While set, changes are refused instead of overwriting it. */
  #invalid: string | null = null;
  #mtime = -1;
  #lastCheck = 0;
  #log: (msg: string, err?: unknown) => void;
  #reloadCheckMs: number;

  /**
   * `path` null = in memory only (tests). A missing file is created with the open defaults. A malformed file throws:
   * it is refused, never silently "fixed" or replaced.
   */
  constructor(path: string | null, opts: AccessPolicyOptions) {
    this.#path = path;
    this.#owners = new Set(opts.owners);
    this.#dashboardUsers = new Set(opts.dashboardUsers ?? []);
    this.#log = opts.log ?? (() => {});
    this.#reloadCheckMs = opts.reloadCheckMs ?? 1000;
    if (path) {
      if (!existsSync(path)) this.#createDefault();
      if (existsSync(path)) this.#load(true);
    }
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

  /**
   * Server-level check for dashboard playback targets. Without a user it is purely about the server; pass the signed-in
   * user so that owners (who bypass whitelist and blacklist everywhere) are never refused.
   */
  guildAllowed(guildId: string, userId?: string): boolean {
    this.#refresh();
    if (userId !== undefined && this.isOwner(userId)) return true;
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
    if (capability === "dashboard" && this.#dashboardUsers.has(userId)) return true;
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
      dashboardUsers: [...this.#dashboardUsers],
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
    // Saving now would overwrite the owner's hand edit (which could not be read) with the last good rules.
    if (this.#invalid && this.#path && existsSync(this.#path)) {
      throw new Error(`${this.#path} is not valid (${this.#invalid}). Nothing was changed and the file was left alone: fix or delete it first.`);
    }
    const next = structuredClone(this.#data);
    mutate(next);
    this.#data = next;
    this.#save();
  }

  #save() {
    if (!this.#path) return;
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, serialize(this.#data), "utf8");
    renameSync(tmp, this.#path);
    this.#mtime = statSync(this.#path).mtimeMs;
  }

  /** First start: write the open defaults. `wx` never replaces a file that appeared in the meantime. */
  #createDefault() {
    try {
      mkdirSync(dirname(this.#path!), { recursive: true });
      writeFileSync(this.#path!, serialize(emptyData()), { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      this.#log(`Could not create ${this.#path}; running with the open defaults in memory only`, err);
    }
  }

  /** Picks up hand edits. A file that became invalid is reported and ignored: the last good policy stays. */
  #refresh(force = false) {
    if (!this.#path) return;
    const now = Date.now();
    if (!force && now - this.#lastCheck < this.#reloadCheckMs) return;
    this.#lastCheck = now;
    try {
      if (!existsSync(this.#path)) {
        this.#invalid = null; // nothing on disk to protect; the next change recreates the file
        return;
      }
      if (statSync(this.#path).mtimeMs === this.#mtime) return;
      this.#load(false);
    } catch (err) {
      this.#log("Could not re-read the access policy file; keeping the previous rules", err);
    }
  }

  #load(strict: boolean) {
    try {
      const raw = JSON.parse(readFileSync(this.#path!, "utf8"));
      const data = parse(raw);
      this.#data = data;
      this.#invalid = null;
      this.#mtime = statSync(this.#path!).mtimeMs;
      if ("owners" in raw) this.#log(`${this.#path}: "owners" is ignored here. Owners are set with OWNER_USER_IDS in .env.`);
    } catch (err) {
      if (strict) throw new Error(`${this.#path}: ${(err as Error).message}`);
      this.#mtime = statSync(this.#path!).mtimeMs; // do not retry the same bad content every second
      this.#invalid = (err as Error).message;
      this.#log(`${this.#path} is invalid (${(err as Error).message}); keeping the previous rules`);
    }
  }
}
