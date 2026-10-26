import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "../access/AccessPolicy.ts";
import type { ImportService } from "../import/ImportService.ts";
import { handleImportRoute } from "./importRoutes.ts";
import { handleLogRoute, type LogFiles } from "./logRoutes.ts";
import { handleCoreApi, type CoreDeps } from "./coreApi.ts";
import { canAdministerAnyGuild, handleEntranceRoute } from "./entranceRoutes.ts";
import type { Client } from "discord.js";
import { SECURITY_HEADERS, contentTypeAllowed, json, readBody, safeEqual } from "./common.ts";
import { parseCookies, serializeCookie } from "./auth/cookies.ts";
import type { DiscordOAuth } from "./auth/discordOAuth.ts";
import type { SessionStore } from "./auth/sessions.ts";

/**
 * PUBLIC listener (default port 3939): the Cloudflare Tunnel origin.
 *
 * Authentication is Discord OAuth2 + a server-side session in an HttpOnly cookie, and nothing else.
 * There is deliberately no access-key code in this file: no ACCESS_KEY, no X-Access-Key, no ?key=.
 * The local integration listener lives in localServer.ts and shares no authentication state with this one.
 */
export interface PublicDeps extends CoreDeps {
  /** Public origin, e.g. https://dash.example.com (or http://localhost:3939 for development). */
  publicBaseUrl: string;
  sessions: SessionStore;
  /** Without it nobody can sign in: every protected route answers 401 and /auth/login answers 503. */
  oauth?: DiscordOAuth;
  /** Called after Discord has proven who the user is. Resolve false to refuse. */
  authorize(userId: string): Promise<boolean>;
  /**
   * What this signed-in user may do, asked on every request so a change by the owner applies at once.
   * `dashboard` = may use the dashboard at all (a user who loses it is signed out), `import` = import page and API,
   * `logs` = log viewer. Sign-in gets a user in; this decides what they can touch.
   */
  can(userId: string, capability: Capability): boolean;
  /** Periodic re-check of live sessions: true keeps, false ends the session (and its streams), null = unknown, keep. */
  recheck?(userId: string): Promise<boolean | null>;
  /** Interval for `recheck`; 0 or unset = never. */
  recheckMs?: number;
  /** Optional media import (page at /import + /api/import/*). Left out = those routes do not exist. */
  importer?: ImportService;
  /** Optional log viewer (page at /logs + /api/logs). Left out = those routes do not exist. */
  logs?: LogFiles;
  /** Discord client used for live guild-scoped entrance administration. */
  discordClient?: Client;
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

type StaticEntry = { file: string; type: string; csp?: string };

const STATIC: Record<string, StaticEntry> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  // "My entrance sound": any signed-in dashboard user. The page plays previews from blob: URLs, hence media-src.
  "/entrance": {
    file: "entrance.html",
    type: "text/html; charset=utf-8",
    csp: "default-src 'none'; script-src 'self'; style-src 'self'; media-src blob:; connect-src 'self'",
  },
  "/entrance.js": { file: "entrance.js", type: "text/javascript; charset=utf-8" },
  "/entrance.css": { file: "entrance.css", type: "text/css; charset=utf-8" },
  "/entrance-admin": { file: "entrance-admin.html", type: "text/html; charset=utf-8", csp: "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" },
  "/entrance-admin.js": { file: "entrance-admin.js", type: "text/javascript; charset=utf-8" },
  "/entrance-admin.css": { file: "entrance-admin.css", type: "text/css; charset=utf-8" },
};

// Served only when an importer is configured. The page plays its own preview audio, hence media-src.
const IMPORT_STATIC: Record<string, StaticEntry> = {
  "/import": {
    file: "import.html",
    type: "text/html; charset=utf-8",
    csp: "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'",
  },
  "/import.js": { file: "import.js", type: "text/javascript; charset=utf-8" },
  "/import.css": { file: "import.css", type: "text/css; charset=utf-8" },
};

// Served only when log files are configured. The page only talks to its own /api/logs.
const LOG_STATIC: Record<string, StaticEntry> = {
  "/logs": {
    file: "logs.html",
    type: "text/html; charset=utf-8",
    csp: "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
  },
  "/logs.js": { file: "logs.js", type: "text/javascript; charset=utf-8" },
  "/logs.css": { file: "logs.css", type: "text/css; charset=utf-8" },
};

// The only files served without a session: the sign-in page's stylesheet.
const PUBLIC_ASSETS: Record<string, StaticEntry> = {
  "/login.css": { file: "login.css", type: "text/css; charset=utf-8" },
};

const PAGES = new Set(["/", "/entrance", "/import", "/logs"]);

/** Which owner-granted permission a route needs, beyond being allowed onto the dashboard at all. */
function requiredCapability(path: string): Capability | null {
  if (path === "/import" || path === "/import.js" || path === "/import.css" || path.startsWith("/api/import/")) return "import";
  if (path === "/logs" || path === "/logs.js" || path === "/logs.css" || path.startsWith("/api/logs")) return "logs";
  return null;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LOGIN_TTL_MS = 10 * 60_000;
const MAX_PENDING_LOGINS = 500;

const text = (res: ServerResponse, status: number, body: string, extra: Record<string, string | string[]> = {}) =>
  void res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra }).end(body);

export function createPublicServer(d: PublicDeps): Server {
  const base = new URL(d.publicBaseUrl);
  const secure = base.protocol === "https:";
  // The __Host- prefix makes browsers refuse a cookie planted by a sibling subdomain or over plain http.
  const SID = secure ? "__Host-aboda_sid" : "aboda_sid";
  const OAUTH = secure ? "__Host-aboda_oauth" : "aboda_oauth";
  const sessionCookie = (value: string, maxAgeSec: number) => serializeCookie(SID, value, { maxAgeSec, secure });
  const oauthCookie = (value: string, maxAgeSec: number) => serializeCookie(OAUTH, value, { maxAgeSec, secure });

  // One-time login states with their PKCE verifier (never sent to the browser). Each state is also bound to the
  // browser that started the login by a cookie.
  const pending = new Map<string, { exp: number; verifier: string }>();
  const rememberState = (state: string, verifier: string) => {
    const now = Date.now();
    for (const [s, p] of pending) if (p.exp <= now) pending.delete(s);
    while (pending.size >= MAX_PENDING_LOGINS) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    pending.set(state, { exp: now + LOGIN_TTL_MS, verifier });
  };
  /** Single use: returns the verifier for a state we issued and that has not expired, else null. */
  const consumeState = (state: string): string | null => {
    const p = pending.get(state);
    pending.delete(state);
    return p && p.exp > Date.now() ? p.verifier : null;
  };

  /** The sign-in page (also used to report sign-in problems). Contains only fixed text, never request data. */
  function loginPage(
    res: ServerResponse,
    status: number,
    message?: string,
    headers: Record<string, string | string[]> = {},
    opts: { back?: boolean } = {},
  ) {
    const action = opts.back
      ? `<a class="btn" href="/">Back to the dashboard</a>`
      : d.oauth
      ? `<a class="btn" href="/auth/login">Login with Discord</a>`
      : `<p class="msg" role="alert">Sign-in is not configured on this server yet. The owner needs to finish the Discord setup described in the README.</p>`;
    const intro = message ? `<p class="msg" role="alert">${esc(message)}</p>` : `<p>Sign in with your Discord account to continue.</p>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><link rel="stylesheet" href="/login.css"></head><body><main><h1>Soundbot dashboard</h1>${intro}${action}</main></body></html>`;
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", ...headers }).end(html);
  }

  /** State-changing requests: right content type, and an Origin header that is exactly this site. */
  function guard(req: IncomingMessage, res: ServerResponse, contentType = "application/json"): boolean {
    if (!contentTypeAllowed(req, res, contentType)) return false;
    let ok = false;
    try {
      ok = !!req.headers.origin && new URL(req.headers.origin).origin === base.origin;
    } catch {
      // invalid Origin
    }
    if (!ok) {
      json(res, 403, { error: "Cross-origin request refused" });
      return false;
    }
    return true;
  }

  function login(res: ServerResponse) {
    if (!d.oauth) return loginPage(res, 503);
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    rememberState(state, verifier);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    res
      .writeHead(302, {
        ...SECURITY_HEADERS,
        Location: d.oauth.authorizeUrl(state, challenge),
        "Set-Cookie": oauthCookie(state, LOGIN_TTL_MS / 1000),
      })
      .end();
  }

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    const clear = oauthCookie("", 0);
    const cookies = parseCookies(req.headers.cookie);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const bound = cookies[OAUTH] ?? "";

    const fail = (status: number, message: string) => loginPage(res, status, message, { "Set-Cookie": clear });

    if (!d.oauth) return loginPage(res, 503, undefined, { "Set-Cookie": clear });
    if (url.searchParams.get("error")) return fail(403, "Sign-in was cancelled.");
    // The state must be one we issued, unused, and the same one this browser was given.
    const verifier = state && code && bound && safeEqual(state, bound) ? consumeState(state) : null;
    if (!verifier) return fail(400, "That sign-in attempt is invalid or has expired. Please try again.");

    let identity;
    try {
      identity = await d.oauth.completeLogin(code, verifier);
    } catch (err) {
      console.error("Discord sign-in failed:", (err as Error).message);
      return fail(502, "Could not complete sign-in with Discord. Please try again.");
    }

    let allowed = false;
    try {
      allowed = await d.authorize(identity.id);
    } catch (err) {
      console.error("Dashboard authorization failed:", (err as Error).message);
    }
    if (!allowed) {
      console.warn(`Dashboard sign-in refused for Discord user ${identity.id}`);
      return fail(403, "Access denied. This Discord account is not allowed to use this dashboard.");
    }

    // Always a brand-new session id (no fixation); any session this browser already had is ended.
    const old = cookies[SID];
    if (old) d.sessions.destroy(old);
    const session = d.sessions.create(identity);
    res
      .writeHead(302, {
        ...SECURITY_HEADERS,
        Location: "/",
        "Set-Cookie": [clear, sessionCookie(session.id, d.sessions.maxAgeMs / 1000)],
      })
      .end();
  }

  function logout(req: IncomingMessage, res: ServerResponse) {
    if (!guard(req, res)) return;
    const sid = parseCookies(req.headers.cookie)[SID];
    if (sid) d.sessions.destroy(sid); // also ends this session's live event streams
    res
      .writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json", "Set-Cookie": sessionCookie("", 0) })
      .end(JSON.stringify({ ok: true }));
  }

  // Tell the owner (console only) which Host was refused, once per distinct value. Printable ASCII only, truncated.
  const rejectedHosts = new Set<string>();
  function logRejectedHost(host: string | undefined) {
    const shown = (host ?? "(none)").replace(/[^\x20-\x7e]/g, "?").slice(0, 100);
    if (rejectedHosts.has(shown) || rejectedHosts.size >= 20) return;
    rejectedHosts.add(shown);
    console.warn(`Public listener refused a request with Host "${shown}" (HTTP 421): it only serves "${base.host}" (from PUBLIC_BASE_URL).`);
  }

  const staticFiles: Record<string, StaticEntry> = {
    ...STATIC,
    ...(d.importer ? IMPORT_STATIC : {}),
    ...(d.logs ? LOG_STATIC : {}),
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");

      // Only the configured public hostname is served (blocks DNS rebinding and stray Host headers). Nothing else
      // decides this: X-Forwarded-Host, Forwarded and friends are ignored on purpose, because any client can send them.
      if ((req.headers.host ?? "").toLowerCase() !== base.host.toLowerCase()) {
        logRejectedHost(req.headers.host);
        return void text(res, 421, "Wrong host name for this server. Open the dashboard at the address the owner configured (PUBLIC_BASE_URL).");
      }

      const isPost = req.method === "POST";
      if (req.method !== "GET" && !isPost) {
        return void res.writeHead(405, { ...SECURITY_HEADERS, Allow: "GET, POST" }).end();
      }

      // ---- the only routes that work without a session
      if (!isPost && url.pathname in PUBLIC_ASSETS) {
        const a = PUBLIC_ASSETS[url.pathname]!;
        return void res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": a.type }).end(await readFile(join(PUBLIC_DIR, a.file)));
      }
      if (!isPost && url.pathname === "/login") {
        const signedIn = parseCookies(req.headers.cookie)[SID];
        if (signedIn && d.sessions.get(signedIn)) return void res.writeHead(302, { ...SECURITY_HEADERS, Location: "/" }).end();
        return loginPage(res, d.oauth ? 200 : 503);
      }
      if (!isPost && url.pathname === "/auth/login") return login(res);
      if (!isPost && url.pathname === "/auth/callback") return await callback(req, res, url);
      if (isPost && url.pathname === "/auth/logout") return logout(req, res);

      // ---- everything else, static files and SSE included, needs a valid server-side session
      const sid = parseCookies(req.headers.cookie)[SID];
      const session = sid ? d.sessions.get(sid) : null;
      if (!session) {
        const wantsPage = !isPost && PAGES.has(url.pathname) && (req.headers.accept ?? "").includes("text/html");
        if (wantsPage) return void res.writeHead(302, { ...SECURITY_HEADERS, Location: "/login" }).end();
        return json(res, 401, { error: "Not signed in", login: "/login" });
      }

      // Sign-in only proves who you are. What you may do comes from the owner's policy, asked every time.
      const uid = session.user.id;
      if (!d.can(uid, "dashboard")) {
        d.sessions.destroy(session.id); // also ends this user's live streams
        const gone = { "Set-Cookie": sessionCookie("", 0) };
        const message = "Your account no longer has access to this dashboard.";
        if (!isPost && PAGES.has(url.pathname)) return loginPage(res, 403, message, gone, { back: false });
        res.writeHead(403, { ...SECURITY_HEADERS, ...gone, "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
        return;
      }

      const needs = requiredCapability(url.pathname);
      if (needs && !d.can(uid, needs)) {
        const message = `Your account does not have permission to use this (${needs}). Ask the bot owner.`;
        if (!isPost && PAGES.has(url.pathname)) return loginPage(res, 403, message, {}, { back: true });
        return json(res, 403, { error: message });
      }

      if (!isPost && url.pathname === "/api/me") {
        return json(res, 200, {
          user: { id: uid, username: session.user.username },
          can: { import: d.can(uid, "import"), logs: d.can(uid, "logs") },
        });
      }

      const core = {
        guard,
        user: { id: uid, username: session.user.username },
        onStream: (stream: ServerResponse) => {
          const detach = d.sessions.attach(session.id, () => stream.end());
          stream.on("close", detach);
        },
      };

      if (d.importer && url.pathname.startsWith("/api/import/")) {
        const handled = await handleImportRoute(d.importer, req, res, url, {
          json,
          guard,
          readBody,
          headers: SECURITY_HEADERS,
          userId: uid,
        });
        if (handled) return;
      }

      if (d.logs && (await handleLogRoute(d.logs, req, res, url, { json, allowedGuildIds: await d.accessibleGuildIds?.(uid) ?? [] }))) return;

      if (await handleCoreApi(d, req, res, url, core)) return;

      // The entrance sound always belongs to the signed-in account of this session; no request can name another user.
      if (await handleEntranceRoute({ ...d, client: d.discordClient }, req, res, url, core)) return;

      if (isPost) return json(res, 404, { error: "Not found" });

      if (url.pathname === "/entrance-admin" || url.pathname === "/entrance-admin.js" || url.pathname === "/entrance-admin.css") {
        if (!d.discordClient || !(await canAdministerAnyGuild(d.discordClient, uid))) {
          return text(res, 403, "Guild administration permission required");
        }
      }

      const file = staticFiles[url.pathname];
      if (file) {
        const body = await readFile(join(PUBLIC_DIR, file.file));
        return void res
          .writeHead(200, {
            ...SECURITY_HEADERS,
            ...(file.csp ? { "Content-Security-Policy": file.csp } : {}),
            "Content-Type": file.type,
          })
          .end(body);
      }

      res.writeHead(404, SECURITY_HEADERS).end("Not found");
    } catch (err) {
      console.error("HTTP handler error:", err);
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end();
    }
  });

  server.on("error", (err) => {
    console.error("Public web server failed:", err.message);
    process.exit(1);
  });

  // Guild/role rules can change after sign-in, so live sessions are re-authorized now and then. Only a definite
  // "no" ends a session; if Discord cannot be reached the session simply lives until its normal expiry.
  if (d.recheck && d.recheckMs && d.recheckMs > 0) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        for (const s of d.sessions.all()) {
          try {
            if ((await d.recheck!(s.user.id)) === false) {
              console.warn(`Dashboard session ended: Discord user ${s.user.id} is no longer authorized.`);
              d.sessions.destroy(s.id);
            }
          } catch {
            // unknown: keep the session
          }
        }
      } finally {
        running = false;
      }
    }, d.recheckMs);
    timer.unref();
    server.on("close", () => clearInterval(timer));
  }

  return server;
}
