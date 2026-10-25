/**
 * Discord OAuth2 authorization-code flow, scope `identify` only. The access token is used once to read the
 * user's id and is then discarded (and revoked on a best-effort basis); it is never stored or logged.
 */
export interface DiscordIdentity {
  id: string;
  username: string;
}

export interface DiscordOAuth {
  /** `codeChallenge` is the S256 PKCE challenge for a verifier the caller keeps server-side. */
  authorizeUrl(state: string, codeChallenge: string): string;
  completeLogin(code: string, codeVerifier: string): Promise<DiscordIdentity>;
}

export interface DiscordOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must be registered under OAuth2 > Redirects in the Discord Developer Portal, character for character. */
  redirectUri: string;
}

const API = "https://discord.com/api/v10";
const TIMEOUT_MS = 10_000;

export function createDiscordOAuth(cfg: DiscordOAuthConfig, fetchImpl: typeof fetch = fetch): DiscordOAuth {
  return {
    authorizeUrl(state, codeChallenge) {
      const u = new URL("https://discord.com/oauth2/authorize");
      u.searchParams.set("client_id", cfg.clientId);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("redirect_uri", cfg.redirectUri);
      u.searchParams.set("scope", "identify");
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
      return u.toString();
    },

    async completeLogin(code, codeVerifier) {
      const form = (extra: Record<string, string>) =>
        new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...extra });

      const tokenRes = await fetchImpl(`${API}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: codeVerifier }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!tokenRes.ok) throw new Error(`Discord token exchange failed (${tokenRes.status})`);
      const token = (await tokenRes.json()) as { access_token?: unknown };
      if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Discord returned no access token");

      try {
        const meRes = await fetchImpl(`${API}/users/@me`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!meRes.ok) throw new Error(`Discord user lookup failed (${meRes.status})`);
        const me = (await meRes.json()) as { id?: unknown; username?: unknown; global_name?: unknown };
        if (typeof me.id !== "string" || !/^\d{15,25}$/.test(me.id)) throw new Error("Discord returned an invalid user id");
        const name = typeof me.global_name === "string" && me.global_name ? me.global_name : typeof me.username === "string" ? me.username : me.id;
        return { id: me.id, username: name.slice(0, 80) };
      } finally {
        // Best effort: the token has done its only job.
        void fetchImpl(`${API}/oauth2/token/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form({ token: token.access_token as string, token_type_hint: "access_token" }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }).catch(() => {});
      }
    },
  };
}
