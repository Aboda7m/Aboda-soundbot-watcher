export interface AuthorizeOptions {
  /** Discord user ids that may always sign in. */
  userIds: string[];
  /** Optional: members of this server may sign in (narrowed by roleIds when given). */
  guildId?: string;
  roleIds: string[];
  /**
   * Resolves the member's role ids, or null if the user is definitely not in that server.
   * Throw when the answer cannot be determined (Discord unreachable, server not loaded): that is
   * "unknown", not "no".
   */
  fetchMember(guildId: string, userId: string): Promise<{ roles: string[] } | null>;
  /** Extra yes (e.g. the owner-managed policy grants dashboard access). */
  extraAllow?(userId: string): boolean;
  /** A yes/no that beats everything else: a blocked user is refused even if a server or id rule would allow them. */
  deny?(userId: string): boolean;
  log?: (msg: string, err?: unknown) => void;
}

export type Authorizer = ((userId: string) => Promise<boolean>) & {
  /** Re-evaluates an existing session: true = still allowed, false = revoked, null = could not tell (keep it for now). */
  recheck(userId: string): Promise<boolean | null>;
};

/**
 * Decides who may use the public dashboard. Signing in is fail-closed: anything not explicitly allowed
 * is refused, and so is any lookup error. Rechecking a live session only revokes on a definite "no", so a
 * Discord outage does not sign everyone out.
 */
export function createAuthorizer(o: AuthorizeOptions): Authorizer {
  const decide = async (userId: string): Promise<"allow" | "deny" | "unknown"> => {
    if (o.deny?.(userId)) return "deny";
    // Public dashboard sign-in is open to all non-blocked Discord accounts.
    return "allow";
  };
  const signIn = async (userId: string) => (await decide(userId)) === "allow";
  const recheck = async (userId: string) => {
    const d = await decide(userId);
    return d === "allow" ? true : d === "deny" ? false : null;
  };
  return Object.assign(signIn, { recheck });
}

export const hasAuthorizationRules = (o: Pick<AuthorizeOptions, "userIds" | "guildId">): boolean =>
  o.userIds.length > 0 || !!o.guildId;
