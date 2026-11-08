import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { SoundRepository } from "../sound/SoundRepository.ts";
import { SECURITY_HEADERS, SNOWFLAKE, json, readBody } from "./common.ts";
import { MIME, type EntranceKit } from "./entranceRoutes.ts";

/**
 * "My exit sound" API. Same trust model as the entrance API: whose exit sound is read or changed is ALWAYS the
 * signed-in Discord account of the session (`kit.user`); no request field names a user.
 *
 *   GET  /api/exit                  { user, sound, exists }   the caller's current exit sound
 *   GET  /api/exit/preview?sound=   the sound file, so the page can play it in the browser
 *   POST /api/exit                  { sound }                 set it
 *   POST /api/exit/clear                                      remove it
 */
export interface ExitDeps {
  library: Pick<SoundLibrary, "has" | "resolve">;
  repo: Pick<SoundRepository, "exit" | "setExit" | "clearExit">;
}

/** Returns true if the request was one of ours (and has been answered). */
export async function handleExitRoute(
  d: ExitDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kit: EntranceKit,
): Promise<boolean> {
  const { pathname } = url;
  const isGet = req.method === "GET";
  const isPost = req.method === "POST";

  const known =
    (isGet && (pathname === "/api/exit" || pathname === "/api/exit/preview")) ||
    (isPost && (pathname === "/api/exit" || pathname === "/api/exit/clear"));
  if (!known) return false;

  const uid = kit.user.id;
  if (!SNOWFLAKE.test(uid)) {
    json(res, 403, { error: "Exit sounds need a Discord sign-in" });
    return true;
  }

  if (isGet && pathname === "/api/exit") {
    const sound = d.repo.exit(uid) ?? null;
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

  if (pathname === "/api/exit/clear") {
    d.repo.clearExit(uid);
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
  if (d.repo.exit(uid) !== sound) d.repo.setExit(uid, sound); // unchanged = no disk write
  json(res, 200, { ok: true, sound });
  return true;
}
