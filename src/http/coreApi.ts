import type { IncomingMessage, ServerResponse } from "node:http";
import type { Watcher } from "../watcher/Watcher.ts";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { SoundRepository } from "../sound/SoundRepository.ts";
import type { SoundQueue } from "../sound/SoundQueue.ts";
import { SECURITY_HEADERS, SNOWFLAKE, json, readBody } from "./common.ts";

/**
 * The playback/voice API: the one set of routes both listeners serve. It contains no authentication of its
 * own; each listener authenticates the request first and hands in its own guard for state-changing calls.
 */
export interface CoreDeps {
  watcher: Watcher;
  library: SoundLibrary;
  repo: SoundRepository;
  queue: SoundQueue;
  /** true if the guild/channel exists and is a voice channel the bot can see */
  canTarget(guildId: string, channelId: string): boolean;
}

export interface CoreKit {
  /** Origin / content-type checks for state-changing requests. Authentication has already happened. */
  guard(req: IncomingMessage, res: ServerResponse, contentType?: string): boolean;
  /** Called with every SSE response, so the listener can end it when the caller's authorization ends. */
  onStream?(res: ServerResponse): void;
  /**
   * The person this request was authenticated as, when the listener has verified one (the public listener
   * passes the signed-in Discord user). Used only to attribute the sound in the play log; left out = unknown.
   */
  user?: { id: string; username?: string | null };
}

/** Returns true if the request was one of ours (and has been answered). */
export async function handleCoreApi(
  d: CoreDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kit: CoreKit,
): Promise<boolean> {
  const { pathname } = url;

  if (req.method === "POST") {
    switch (pathname) {
      case "/api/play":
        await play(d, req, res, kit);
        return true;
      case "/api/queue/remove":
        await queueControl(d, req, res, kit, "remove");
        return true;
      case "/api/queue/skip":
        await queueControl(d, req, res, kit, "skip");
        return true;
      case "/api/queue/clear-pending":
        await queueControl(d, req, res, kit, "clear-pending");
        return true;
    }
    return false;
  }

  switch (pathname) {
    case "/events":
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      kit.onStream?.(res);
      d.watcher.addClient(res);
      return true;

    case "/api/voice":
      res
        .writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json" })
        .end(d.watcher.payloadJson());
      return true;

    case "/api/status":
      json(res, 200, { playback: d.queue.status() });
      return true;

    case "/api/sounds": {
      const meta = new Map(d.repo.sounds().map((s) => [s.name, s]));
      json(res, 200, {
        sounds: d.library.list().map((name) => ({
          name,
          count: meta.get(name)?.count ?? 0,
          tags: meta.get(name)?.tags ?? [],
        })),
      });
      return true;
    }
  }
  return false;
}

async function play(d: CoreDeps, req: IncomingMessage, res: ServerResponse, kit: CoreKit) {
  if (!kit.guard(req, res)) return;

  let body: { sound?: unknown; guildId?: unknown; channelId?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "Body must be valid JSON under 2 KB" });
  }

  const { sound, guildId, channelId } = body ?? {};
  if (typeof sound !== "string" || typeof guildId !== "string" || typeof channelId !== "string") {
    return json(res, 400, { error: "sound, guildId and channelId must be strings" });
  }
  if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) {
    return json(res, 400, { error: "guildId/channelId are not valid ids" });
  }
  if (!d.library.has(sound)) return json(res, 404, { error: "Unknown sound" });
  if (!d.canTarget(guildId, channelId)) return json(res, 404, { error: "Unknown guild or voice channel" });

  const result = d.queue.enqueue({
    sound,
    guildId,
    channelId,
    source: "manual",
    trigger: "web",
    requestedBy: kit.user ? { userId: kit.user.id, username: kit.user.username ?? null } : null,
  });
  if (result.ok) return json(res, 202, { ok: true, position: result.position });

  const status = result.reason === "queue-full" ? 429 : result.reason === "duplicate" ? 409 : 503;
  return json(res, status, { ok: false, reason: result.reason });
}

async function queueControl(
  d: CoreDeps,
  req: IncomingMessage,
  res: ServerResponse,
  kit: CoreKit,
  action: "remove" | "skip" | "clear-pending",
) {
  if (!kit.guard(req, res)) return;

  let body: { guildId?: unknown; id?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "Body must be valid JSON under 2 KB" });
  }

  const { guildId, id } = body ?? {};
  if (typeof guildId !== "string" || !SNOWFLAKE.test(guildId)) {
    return json(res, 400, { error: "guildId must be a valid id" });
  }

  switch (action) {
    case "remove":
      if (typeof id !== "string" || id.length === 0 || id.length > 100) {
        return json(res, 400, { error: "id must be a valid queue item id" });
      }
      if (!d.queue.removeQueued(guildId, id)) return json(res, 404, { ok: false, error: "Queued item not found" });
      return json(res, 200, { ok: true });

    case "skip":
      if (!d.queue.skipCurrent(guildId)) return json(res, 409, { ok: false, error: "Nothing is currently playing" });
      return json(res, 200, { ok: true });

    case "clear-pending":
      d.queue.clearPending(guildId);
      return json(res, 200, { ok: true });
  }
}
