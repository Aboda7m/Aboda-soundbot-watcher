import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleCoreApi, type CoreDeps } from "./coreApi.ts";
import { SECURITY_HEADERS, contentTypeAllowed, isLoopbackHost, json, safeEqual } from "./common.ts";

/**
 * LOCAL integration listener (default 127.0.0.1:3940) for existing tools, scripts and the Nexus panel.
 *
 * - Authentication is the access key in the `X-Access-Key` header, on every request (reads, SSE and writes).
 *   The key is never read from the URL, so it cannot end up in logs, history or Referer headers.
 * - It serves only the playback/voice API (the routes in coreApi.ts). No pages, no static files, no import,
 *   no logs, no login routes.
 * - It shares no authentication code or state with the public listener (server.ts): a valid access key is
 *   worthless there, and a dashboard session is worthless here.
 * - Binding (see config.ts) is what limits who can connect; the key is a second layer, not a substitute.
 */
export interface LocalDeps extends CoreDeps {
  /** Address this listener is bound to; loopback binds also get the Host-header check. */
  host: string;
  accessKey: string;
}

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];

export function createLocalServer(d: LocalDeps): Server {
  if (!d.accessKey) throw new Error("The local listener refuses to run without an access key.");
  const loopback = isLoopbackHost(d.host);

  const keyOk = (req: IncomingMessage): boolean => {
    const given = req.headers["x-access-key"];
    return typeof given === "string" && safeEqual(given, d.accessKey);
  };

  /** Content type + same-origin rule for writes; the key was already checked for the request. */
  function guard(req: IncomingMessage, res: ServerResponse, contentType = "application/json"): boolean {
    if (!contentTypeAllowed(req, res, contentType)) return false;
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === req.headers.host;
      } catch {
        // invalid Origin
      }
      if (!ok) {
        json(res, 403, { error: "Cross-origin request refused" });
        return false;
      }
    }
    return true;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");

      if (loopback) {
        const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
        if (!LOOPBACK_NAMES.includes(hostName)) return void res.writeHead(403).end();
      }

      if (req.method !== "GET" && req.method !== "POST") {
        return void res.writeHead(405, { ...SECURITY_HEADERS, Allow: "GET, POST" }).end();
      }

      if (!keyOk(req)) {
        return json(res, 401, { error: "Missing or wrong X-Access-Key header (keys in the URL are not accepted)" });
      }

      if (await handleCoreApi(d, req, res, url, { guard })) return;

      json(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("Local HTTP handler error:", err);
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end();
    }
  });

  server.on("error", (err) => {
    console.error("Local integration server failed:", err.message);
    process.exit(1);
  });

  return server;
}
