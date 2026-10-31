import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
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
const TRACK = /^\/api\/stremio\/t\/([0-9a-f]{32})\/(?:sub-(\d{1,2})\.vtt|audio-(\d{1,2})\.m4a)$/;

/** Static file with Range support (the browser's <audio> seeks with it). */
function serveFile(req: IncomingMessage, res: ServerResponse, path: string, type: string, headers: Record<string, string>) {
  const size = statSync(path).size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  let start = 0; let end = size - 1; let status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1] === "") start = Math.max(0, size - Number(m[2])); else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    if (start > end || start >= size) { res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end(); return; }
    status = 206;
  }
  res.writeHead(status, { ...headers, "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(path, { start, end }).on("error", () => res.destroy()).pipe(res);
}

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

  // Subtitle / audio files for viewers: any signed-in dashboard user, ids are unguessable and only exist for sources /play registered.
  const tm = TRACK.exec(pathname);
  if (tm) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { ...kit.headers, Allow: "GET, HEAD" }).end(); return true; }
    const tracks = svc.tracks;
    if (!tracks) { kit.json(res, 404, { error: "Tracks are not enabled." }); return true; }
    const cacheable = { ...kit.headers, "Cache-Control": "private, max-age=3600" };
    try {
      if (tm[2] !== undefined) {
        const file = await tracks.subtitleFile(tm[1]!, Number(tm[2]));
        if (!file) kit.json(res, 404, { error: "Subtitle track not available." }); else serveFile(req, res, file, "text/vtt; charset=utf-8", cacheable);
      } else {
        const st = tracks.audioStatus(tm[1]!, Number(tm[3]));
        if (st.status === "ready") serveFile(req, res, st.path, "audio/mp4", cacheable);
        else if (st.status === "preparing") kit.json(res, 202, { status: "preparing" });
        else if (st.status === "failed") kit.json(res, 500, { error: st.error });
        else kit.json(res, 404, { error: "Audio track not available." });
      }
    } catch (err) { console.error("Stremio track route error:", err); if (!res.headersSent) kit.json(res, 500, { error: "Track request failed." }); }
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
      // Subtitle / audio tracks are found in the background and pushed to everyone in the room when ready.
      if (playback.tracksId && svc.tracks) {
        const watch = kit.watch;
        void svc.tracks.probe(playback.tracksId).then((t) => watch.setTracks(room, playback.url, t)).catch((err: Error) => console.warn(`Track probe failed: ${err.message}`));
      }
      return kit.json(res, 200, { ok: true, mode: playback.mode, title: playback.title }), true;
    }
  } catch (err) { fail(err); return true; }

  res.writeHead(404, kit.headers).end("Not found");
  return true;
}
