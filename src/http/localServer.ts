
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleCoreApi, type CoreDeps } from "./coreApi.ts";
import {
  SECURITY_HEADERS,
  contentTypeAllowed,
  isLoopbackHost,
  isPrivateNetworkHost,
  json,
  readBody,
  safeEqual,
} from "./common.ts";
import { parseCookies, serializeCookie } from "./auth/cookies.ts";
import type { SessionStore } from "./auth/sessions.ts";

/**
 * LOCAL listener (default 127.0.0.1:3940).
 *
 * Authentication:
 *   - Tools/API: X-Access-Key header or ?key= query parameter.
 *   - Browser: sign in using the key, or open /?key=KEY to establish a
 *     session and redirect to a clean URL.
 *   - Browser sessions use an HttpOnly cookie.
 *
 * This listener is separate from the public listener (server.ts).
 *
 * WARNING: URL keys can appear in browser history, logs and monitoring.
 * Plain HTTP on a LAN also exposes credentials to network observers.
 */
export interface LocalDeps extends CoreDeps {
  host: string;
  accessKey: string;
  dashboard?: { sessions: SessionStore };
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];
const SID = "aboda_local_sid";
const MAX_FAILS = 8;
const FAIL_WINDOW_MS = 10 * 60_000;

const PAGE_CSP = "default-src 'none'; style-src 'self'; form-action 'self'";
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createLocalServer(d: LocalDeps): Server {
  if (!d.accessKey) {
    throw new Error("The local listener refuses to run without an access key.");
  }

  const loopback = isLoopbackHost(d.host);
  const sessions = d.dashboard?.sessions;

  // Failed key attempts per client address.
  const fails = new Map<string, number[]>();

  const recent = (ip: string) => {
    const now = Date.now();
    const list = (fails.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);

    if (list.length) fails.set(ip, list);
    else fails.delete(ip);

    return list;
  };

  const noteFail = (ip: string) => {
    if (fails.size > 1000) fails.clear();
    fails.set(ip, [...recent(ip), Date.now()]);
  };

  // Header authentication remains supported. Query authentication is
  // supported for clients that cannot conveniently set custom headers.
  const keyOk = (req: IncomingMessage, url: URL): boolean => {
    const headerKey = req.headers["x-access-key"];

    if (
      typeof headerKey === "string" &&
      safeEqual(headerKey, d.accessKey)
    ) {
      return true;
    }

    const queryKey = url.searchParams.get("key");

    return queryKey !== null && safeEqual(queryKey, d.accessKey);
  };

  const originMatches = (req: IncomingMessage): boolean => {
    try {
      return (
        !!req.headers.origin &&
        new URL(req.headers.origin).host === req.headers.host
      );
    } catch {
      return false;
    }
  };

  function signInPage(
    res: ServerResponse,
    status: number,
    message?: string,
    extra: Record<string, string> = {},
  ) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><link rel="stylesheet" href="/login.css"></head><body><main><h1>Soundbot (local)</h1>${
      message
        ? `<p class="msg" role="alert">${esc(message)}</p>`
        : "<p>Enter the local access key.</p>"
    }<form method="post" action="/auth/key-login"><input type="password" name="key" autocomplete="off" autofocus required aria-label="Access key"><button class="btn" type="submit">Sign in</button></form></main></body></html>`;

    res
      .writeHead(status, {
        ...SECURITY_HEADERS,
        "Content-Security-Policy": PAGE_CSP,
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "same-origin",
        ...extra,
      })
      .end(html);
  }

  const cookie = (value: string, maxAgeSec: number) =>
    serializeCookie(SID, value, { maxAgeSec, secure: false }).replace(
      "SameSite=Lax",
      "SameSite=Strict",
    );

  async function keyLogin(req: IncomingMessage, res: ServerResponse) {
    const ip = req.socket.remoteAddress ?? "?";

    if (recent(ip).length >= MAX_FAILS) {
      return signInPage(
        res,
        429,
        "Too many wrong keys. Wait a few minutes and try again.",
        { "Retry-After": "600" },
      );
    }

    if (
      req.headers["content-type"]?.split(";")[0]?.trim() !==
      "application/x-www-form-urlencoded"
    ) {
      return json(res, 415, {
        error: "Content-Type must be application/x-www-form-urlencoded",
      });
    }

    if (req.headers.origin && !originMatches(req)) {
      return json(res, 403, { error: "Cross-origin request refused" });
    }

    let key = "";

    try {
      key = new URLSearchParams(await readBody(req)).get("key") ?? "";
    } catch {
      return json(res, 400, { error: "Body too large" });
    }

    if (!safeEqual(key, d.accessKey)) {
      noteFail(ip);
      return signInPage(res, 401, "That key is not correct.");
    }

    fails.delete(ip);

    const s = sessions!.create({
      id: "local-key",
      username: "Local access key",
    });

    res
      .writeHead(302, {
        ...SECURITY_HEADERS,
        Location: "/",
        "Set-Cookie": cookie(s.id, sessions!.maxAgeMs / 1000),
      })
      .end();
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");

      // Restrict Host names according to the listener's bind address.
      const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");

      if (
        loopback
          ? !LOOPBACK_NAMES.includes(hostName)
          : !isPrivateNetworkHost(req.headers.host)
      ) {
        return void res.writeHead(403).end();
      }

      const isGet = req.method === "GET";
      const isPost = req.method === "POST";

      if (!isGet && !isPost) {
        return void res
          .writeHead(405, {
            ...SECURITY_HEADERS,
            Allow: "GET, POST",
          })
          .end();
      }

      const sid = sessions ? parseCookies(req.headers.cookie)[SID] : undefined;
      const session = sid && sessions ? sessions.get(sid) : null;

      // ---- Browser sign-in and session management.
      if (sessions) {
        if (isGet && url.pathname === "/login.css") {
          return void res
            .writeHead(200, {
              ...SECURITY_HEADERS,
              "Content-Type": "text/css; charset=utf-8",
            })
            .end(await readFile(join(PUBLIC_DIR, "login.css")));
        }

        if (isPost && url.pathname === "/auth/key-login") {
          return await keyLogin(req, res);
        }

        if (isPost && url.pathname === "/auth/logout") {
          if (
            !originMatches(req) ||
            !contentTypeAllowed(req, res, "application/json")
          ) {
            if (!res.headersSent) {
              json(res, 403, { error: "Cross-origin request refused" });
            }
            return;
          }

          if (sid) sessions.destroy(sid);

          return void res
            .writeHead(200, {
              ...SECURITY_HEADERS,
              "Content-Type": "application/json",
              "Set-Cookie": cookie("", 0),
            })
            .end('{"ok":true}');
        }
      }

      const viaKey = keyOk(req, url);

      // Exchange a valid URL key for a session, then remove the key from
      // the browser address bar before loading the dashboard.
      if (
        sessions &&
        isGet &&
        url.pathname === "/" &&
        url.searchParams.has("key") &&
        viaKey
      ) {
        const s = sessions.create({
          id: "local-key",
          username: "Local access key",
        });

        return void res
          .writeHead(302, {
            ...SECURITY_HEADERS,
            Location: "/",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Set-Cookie": cookie(s.id, sessions.maxAgeMs / 1000),
          })
          .end();
      }

      if (!viaKey && !session) {
        if (sessions && isGet && url.pathname === "/") {
          return signInPage(res, 200);
        }

        return json(res, 401, {
          error: "Missing or wrong access key",
        });
      }

      /** Writes require the expected content type and same-origin checks
       * for cookie-authenticated requests.
       */
      function guard(
        r: IncomingMessage,
        s: ServerResponse,
        contentType = "application/json",
      ): boolean {
        if (!contentTypeAllowed(r, s, contentType)) return false;

        if (r.headers.origin ? !originMatches(r) : !viaKey) {
          json(s, 403, { error: "Cross-origin request refused" });
          return false;
        }

        return true;
      }

      // ---- Dashboard pages are served to authenticated browser sessions.
      if (session && isGet) {
        if (url.pathname === "/api/me") {
          return json(res, 200, {
            user: {
              id: session.user.id,
              username: session.user.username,
            },
            can: { import: false, logs: false },
          });
        }

        const file = STATIC[url.pathname];

        if (file) {
          return void res
            .writeHead(200, {
              ...SECURITY_HEADERS,
              "Content-Type": file.type,
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
            })
            .end(await readFile(join(PUBLIC_DIR, file.file)));
        }
      }

      const core = {
        guard,
        onStream: (stream: ServerResponse) => {
          if (!session || viaKey) return;

          const detach = sessions!.attach(session.id, () => stream.end());
          stream.on("close", detach);
        },
      };

      if (await handleCoreApi(d, req, res, url, core)) return;

      json(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("Local HTTP handler error:", err);

      if (!res.headersSent) {
        res.writeHead(500, SECURITY_HEADERS);
      }

      res.end();
    }
  });

  server.on("error", (err) => {
    console.error("Local integration server failed:", err.message);
    process.exit(1);
  });

  return server;
}
