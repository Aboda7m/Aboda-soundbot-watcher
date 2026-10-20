
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Watcher } from "../watcher/Watcher.ts";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { SoundRepository } from "../sound/SoundRepository.ts";
import type { SoundQueue } from "../sound/SoundQueue.ts";

export interface HttpDeps {
  host: string;
  port: number;
  accessKey: string;
  watcher: Watcher;
  library: SoundLibrary;
  repo: SoundRepository;
  queue: SoundQueue;
  /** true if the guild/channel exists and is a voice channel the bot can see */
  canTarget(guildId: string, channelId: string): boolean;
}

const PUBLIC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "public",
);

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src https://cdn.discordapp.com; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const SNOWFLAKE = /^\d{15,25}$/;
const MAX_BODY = 2048;

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function json(res: ServerResponse, status: number, body: unknown) {
  res
    .writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json",
    })
    .end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (c: Buffer) => {
      size += c.length;

      if (size > MAX_BODY) {
        reject(new Error("too-large"));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

export function createHttpServer(d: HttpDeps): Server {
  const loopbackOnly = ["127.0.0.1", "localhost", "::1"].includes(d.host);

  /** Guards every state-changing request. */
  function mutationAllowed(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    // Require JSON so cross-origin browser requests require a preflight,
    // which this server does not permit.
    if (
      req.headers["content-type"]?.split(";")[0]?.trim() !==
      "application/json"
    ) {
      json(res, 415, {
        error: "Content-Type must be application/json",
      });
      return false;
    }

    const origin = req.headers.origin;

    if (origin) {
      let ok = false;

      try {
        ok = new URL(origin).host === req.headers.host;
      } catch {
        // Invalid origin.
      }

      if (!ok) {
        json(res, 403, { error: "Cross-origin request refused" });
        return false;
      }
    }

    if (d.accessKey) {
      const given = req.headers["x-access-key"];

      if (
        typeof given !== "string" ||
        !safeEqual(given, d.accessKey)
      ) {
        json(res, 401, {
          error: "Missing or wrong X-Access-Key",
        });
        return false;
      }
    } else if (!loopbackOnly) {
      json(res, 403, {
        error:
          "Set ACCESS_KEY to allow playback when listening beyond localhost",
      });
      return false;
    }

    return true;
  }

  async function play(req: IncomingMessage, res: ServerResponse) {
    if (!mutationAllowed(req, res)) return;

    let body: {
      sound?: unknown;
      guildId?: unknown;
      channelId?: unknown;
    };

    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, {
        error: "Body must be valid JSON under 2 KB",
      });
    }

    const { sound, guildId, channelId } = body ?? {};

    if (
      typeof sound !== "string" ||
      typeof guildId !== "string" ||
      typeof channelId !== "string"
    ) {
      return json(res, 400, {
        error: "sound, guildId and channelId must be strings",
      });
    }

    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) {
      return json(res, 400, {
        error: "guildId/channelId are not valid ids",
      });
    }

    if (!d.library.has(sound)) {
      return json(res, 404, { error: "Unknown sound" });
    }

    if (!d.canTarget(guildId, channelId)) {
      return json(res, 404, {
        error: "Unknown guild or voice channel",
      });
    }

    const result = d.queue.enqueue({
      sound,
      guildId,
      channelId,
      source: "manual",
    });

    if (result.ok) {
      return json(res, 202, {
        ok: true,
        position: result.position,
      });
    }

    const status =
      result.reason === "queue-full"
        ? 429
        : result.reason === "duplicate"
          ? 409
          : 503;

    return json(res, status, {
      ok: false,
      reason: result.reason,
    });
  }

  async function queueControl(
    req: IncomingMessage,
    res: ServerResponse,
    action: "remove" | "skip" | "clear-pending",
  ) {
    if (!mutationAllowed(req, res)) return;

    let body: { guildId?: unknown; id?: unknown };

    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, {
        error: "Body must be valid JSON under 2 KB",
      });
    }

    const { guildId, id } = body ?? {};

    if (typeof guildId !== "string" || !SNOWFLAKE.test(guildId)) {
      return json(res, 400, {
        error: "guildId must be a valid id",
      });
    }

    switch (action) {
      case "remove": {
        if (
          typeof id !== "string" ||
          id.length === 0 ||
          id.length > 100
        ) {
          return json(res, 400, {
            error: "id must be a valid queue item id",
          });
        }

        if (!d.queue.removeQueued(guildId, id)) {
          return json(res, 404, {
            ok: false,
            error: "Queued item not found",
          });
        }

        return json(res, 200, { ok: true });
      }

      case "skip": {
        if (!d.queue.skipCurrent(guildId)) {
          return json(res, 409, {
            ok: false,
            error: "Nothing is currently playing",
          });
        }

        return json(res, 200, { ok: true });
      }

      case "clear-pending": {
        d.queue.clearPending(guildId);
        return json(res, 200, { ok: true });
      }
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");

      // Blocks DNS-rebinding through unexpected hostnames on loopback.
      if (loopbackOnly) {
        const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");

        if (!["localhost", "127.0.0.1", "[::1]"].includes(hostName)) {
          return void res.writeHead(403).end();
        }
      }

      const isPost = req.method === "POST";

      if (req.method !== "GET" && !isPost) {
        return void res
          .writeHead(405, { Allow: "GET, POST" })
          .end();
      }

      // Static frontend assets are allowed to load without the key.
      // Data APIs and event streams require the key when configured.
      const isStaticFile = url.pathname in STATIC;

      if (!isPost && d.accessKey && !isStaticFile) {
        const given =
          url.searchParams.get("key") ??
          (req.headers["x-access-key"] as string | undefined) ??
          "";

        if (!safeEqual(given, d.accessKey)) {
          return void res
            .writeHead(401, SECURITY_HEADERS)
            .end("Missing or wrong key.");
        }
      }

      if (isPost && url.pathname === "/api/play") {
        return await play(req, res);
      }

      if (isPost && url.pathname === "/api/queue/remove") {
        return await queueControl(req, res, "remove");
      }

      if (isPost && url.pathname === "/api/queue/skip") {
        return await queueControl(req, res, "skip");
      }

      if (isPost && url.pathname === "/api/queue/clear-pending") {
        return await queueControl(req, res, "clear-pending");
      }

      if (isPost) {
        return json(res, 404, { error: "Not found" });
      }

      switch (url.pathname) {
        case "/events":
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          return d.watcher.addClient(res);

        case "/api/voice":
          return void res
            .writeHead(200, {
              ...SECURITY_HEADERS,
              "Content-Type": "application/json",
            })
            .end(d.watcher.payloadJson());

        case "/api/status":
          return json(res, 200, {
            playback: d.queue.status(),
          });

        case "/api/sounds": {
          const meta = new Map(
            d.repo.sounds().map((s) => [s.name, s]),
          );

          return json(res, 200, {
            sounds: d.library.list().map((name) => ({
              name,
              count: meta.get(name)?.count ?? 0,
              tags: meta.get(name)?.tags ?? [],
            })),
          });
        }
      }

      const file = STATIC[url.pathname];

      if (file) {
        const body = await readFile(join(PUBLIC_DIR, file.file));

        return void res
          .writeHead(200, {
            ...SECURITY_HEADERS,
            "Content-Type": file.type,
          })
          .end(body);
      }

      res.writeHead(404, SECURITY_HEADERS).end("Not found");
    } catch (err) {
      console.error("HTTP handler error:", err);

      if (!res.headersSent) {
        res.writeHead(500, SECURITY_HEADERS);
      }

      res.end();
    }
  });

  server.on("error", (err) => {
    console.error(
      `Web server failed on ${d.host}:${d.port}:`,
      err.message,
    );
    process.exit(1);
  });

  return server;
}
