import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { SoundRepository } from "../sound/SoundRepository.ts";
import { SECURITY_HEADERS, SNOWFLAKE, json, readBody } from "./common.ts";

/**
 * "My entrance sound" API. Public listener only: it needs a Discord identity, and the local listener has none.
 *
 * Whose entrance sound is read or changed is ALWAYS the signed-in Discord account of the session (`kit.user`).
 * No request field names a user, so there is nothing to tamper with. Authentication, the dashboard permission and
 * the Origin / content-type check for POSTs happen before this file is reached.
 *
 *   GET  /api/entrance                  { user, sound, exists }   the caller's current entrance sound
 *   GET  /api/entrance/preview?sound=   the sound file, so the page can play it in the browser
 *   POST /api/entrance                  { sound }                 set it
 *   POST /api/entrance/clear                                      remove it
 */
export interface EntranceDeps {
  library: Pick<SoundLibrary, "has" | "resolve">;
  repo: Pick<SoundRepository, "entrance" | "setEntrance" | "clearEntrance">;
}

export interface EntranceKit {
  user: { id: string; username: string };
  guard(req: IncomingMessage, res: ServerResponse, contentType?: string): boolean;
}

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

/** Returns true if the request was one of ours (and has been answered). */
export async function handleEntranceRoute(
  d: EntranceDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kit: EntranceKit,
): Promise<boolean> {
  const { pathname } = url;
  const isGet = req.method === "GET";
  const isPost = req.method === "POST";

  const known =
    (isGet && (pathname === "/api/entrance" || pathname === "/api/entrance/preview")) ||
    (isPost && (pathname === "/api/entrance" || pathname === "/api/entrance/clear"));
  if (!known) return false;

  const uid = kit.user.id;
  if (!SNOWFLAKE.test(uid)) {
    json(res, 403, { error: "Entrance sounds need a Discord sign-in" });
    return true;
  }

  if (isGet && pathname === "/api/entrance") {
    const sound = d.repo.entrance(uid) ?? null;
    json(res, 200, {
      user: { id: uid, username: kit.user.username },
      sound,
      exists: sound === null ? false : d.library.has(sound),
    });
    return true;
  }

  if (isGet) {
    // Names are looked up in the library's directory scan, never joined onto a path, so "../x" is simply unknown.
    const file = d.library.resolve(url.searchParams.get("sound") ?? "");
    let size = -1;
    try {
      if (file) size = statSync(file).size;
    } catch {
      // vanished since the last scan
    }
    if (!file || size < 0) {
      json(res, 404, { error: "Unknown sound" });
      return true;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": size,
    });
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
    return true;
  }

  if (!kit.guard(req, res)) return true;

  if (pathname === "/api/entrance/clear") {
    d.repo.clearEntrance(uid);
    json(res, 200, { ok: true });
    return true;
  }

  let body: { sound?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Body must be valid JSON under 2 KB" });
    return true;
  }
  const sound = body?.sound;
  if (typeof sound !== "string" || sound.length === 0 || sound.length > 200) {
    json(res, 400, { error: "sound must be a sound name" });
    return true;
  }
  if (!d.library.has(sound)) {
    json(res, 404, { error: "Unknown sound" });
    return true;
  }
  if (d.repo.entrance(uid) !== sound) d.repo.setEntrance(uid, sound); // unchanged = no disk write
  json(res, 200, { ok: true, sound });
  return true;
}
