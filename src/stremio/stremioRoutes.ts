import type { IncomingMessage, ServerResponse } from "node:http";
import type { StremioService } from "./StremioService.ts";
import { StremioError } from "./StremioService.ts";
import type { WatchManager } from "../watch/WatchManager.ts";

/** What these routes borrow from server.ts so they share its auth, headers and JSON helper. */
export interface StremioKit {
  json(res: ServerResponse, status: number, body: unknown): void;
  guard(req: IncomingMessage, res: ServerResponse, contentType?: string): boolean;
  readBody(req: IncomingMessage): Promise<string>;
  headers: Record<string, string>;
  userId: string;
  /** Whether the signed-in user holds the `stremio` permission (the stream proxy itself only needs a session). */
  allowed: boolean;
  watch?: WatchManager;
}

const TYPE = /^[a-z][a-z0-9_-]{1,29}$/;
const ID = /^[A-Za-z0-9_:.\-]{1,120}$/;
const PROXY = /^\/api\/stremio\/s\/([0-9a-f]{32})\/(.{1,200})$/;

/** Returns true if the request was one of ours (and has been answered). */
export async function handleStremioRoute(svc: StremioService, req: IncomingMessage, res: ServerResponse, url: URL, kit: StremioKit): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/stremio/")) return false;

  // Playback proxy: any signed-in dashboard user (the viewers). Only ids created by /play resolve.
  const px = PROXY.exec(pathname);
  if (px) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { ...kit.headers, Allow: "GET, HEAD" }).end(); return true; }
    svc.serveProxy(px[1]!, px[2]!, req, res, kit.headers);
    return true;
  }

  if (!kit.allowed) { kit.json(res, 403, { error: "Your account does not have permission to use this (stremio). Ask the bot owner." }); return true; }

  const fail = (err: unknown) => {
    if (err instanceof StremioError) return kit.json(res, err.status, { error: err.message });
    console.error("Stremio route error:", err);
    kit.json(res, 502, { error: "The addon request failed. Try again." });
  };

  try {
    if (req.method === "GET" && pathname === "/api/stremio/status") {
      const addons = await svc.addons();
      return kit.json(res, 200, { addons: addons.map((a) => a.name) }), true;
    }
    if (req.method === "GET" && pathname === "/api/stremio/search") {
      return kit.json(res, 200, { results: await svc.search(url.searchParams.get("q") ?? "") }), true;
    }
    if (req.method === "GET" && (pathname === "/api/stremio/meta" || pathname === "/api/stremio/streams")) {
      const type = url.searchParams.get("type") ?? ""; const id = url.searchParams.get("id") ?? "";
      if (!TYPE.test(type) || !ID.test(id)) return kit.json(res, 400, { error: "Invalid type or id." }), true;
      return kit.json(res, 200, pathname.endsWith("/meta") ? { meta: await svc.meta(type, id) } : { streams: await svc.streams(type, id) }), true;
    }
    if (req.method === "POST" && pathname === "/api/stremio/play") {
      if (!kit.guard(req, res, "application/json")) return true;
      let body: Record<string, unknown>;
      try { body = JSON.parse(await kit.readBody(req)); } catch { return kit.json(res, 400, { error: "Invalid JSON body." }), true; }
      if (!kit.watch) return kit.json(res, 503, { error: "Watch Together is not enabled." }), true;
      const room = kit.watch.getRoom(String(body.guildId ?? ""), String(body.channelId ?? ""));
      if (!room || !room.participants.some((p) => p.userId === kit.userId)) {
        return kit.json(res, 403, { error: "Join the Discord voice channel of that watch room first." }), true;
      }
      const playback = await svc.play(String(body.ref ?? ""), { transcode: body.transcode === true });
      try { kit.watch.command(room, kit.userId, { action: "media", url: playback.url, title: playback.title }); }
      catch (err) { return kit.json(res, 400, { error: (err as Error).message }), true; }
      return kit.json(res, 200, { ok: true, mode: playback.mode, title: playback.title }), true;
    }
  } catch (err) { fail(err); return true; }

  res.writeHead(404, kit.headers).end("Not found");
  return true;
}
