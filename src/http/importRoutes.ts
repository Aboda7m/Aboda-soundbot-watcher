import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { ImportError, type ImportService } from "../import/ImportService.ts";

/** What the import routes borrow from server.ts so they share its auth, headers and JSON helper. */
export interface RouteKit {
  json(res: ServerResponse, status: number, body: unknown): void;
  /** Same guard as every other state-changing route (origin check + access key), for the given content type. */
  guard(req: IncomingMessage, res: ServerResponse, contentType: string): boolean;
  readBody(req: IncomingMessage): Promise<string>;
  headers: Record<string, string>;
}

const PREVIEW = /^\/api\/import\/preview\/([0-9a-f-]{36})$/;

/** Returns true if the request was one of ours (and has been answered). */
export async function handleImportRoute(
  importer: ImportService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kit: RouteKit,
): Promise<boolean> {
  const { pathname } = url;
  const isPost = req.method === "POST";

  const readJson = async (): Promise<Record<string, unknown> | null> => {
    try {
      const v = JSON.parse(await kit.readBody(req));
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const fail = (err: unknown) => {
    if (err instanceof ImportError) {
      // An early refusal leaves the upload unread: close the connection instead of draining it.
      if (!req.complete) {
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
      }
      return kit.json(res, err.status, { ok: false, error: err.message });
    }
    console.error("Import error:", err);
    return kit.json(res, 500, { ok: false, error: "Unexpected server error while importing." });
  };

  if (!isPost && pathname === "/api/import/config") {
    const status = await importer.status();
    kit.json(res, 200, { ...importer.limits(), ...status });
    return true;
  }

  if (!isPost) {
    const m = PREVIEW.exec(pathname);
    if (!m) return false;
    await sendPreview(importer, m[1]!, req, res, kit);
    return true;
  }

  if (pathname === "/api/import/upload") {
    if (!kit.guard(req, res, "application/octet-stream")) return true;
    const rawName = req.headers["x-filename"];
    let fileName = "";
    try {
      fileName = typeof rawName === "string" ? decodeURIComponent(rawName) : "";
    } catch {
      // handled as missing below
    }
    if (!fileName) {
      fail(new ImportError(400, "Missing X-Filename header."));
      return true;
    }
    const len = req.headers["content-length"];
    const declared = typeof len === "string" && /^\d+$/.test(len) ? Number(len) : null;
    try {
      kit.json(res, 201, { ok: true, ...(await importer.stage(req, fileName, declared)) });
    } catch (err) {
      fail(err);
    }
    return true;
  }

  if (pathname === "/api/import/save") {
    if (!kit.guard(req, res, "application/json")) return true;
    const body = await readJson();
    if (!body || typeof body.id !== "string") {
      kit.json(res, 400, { ok: false, error: "Body must be JSON with id and name." });
      return true;
    }
    try {
      kit.json(res, 201, { ok: true, ...(await importer.save(body.id, body.name)) });
    } catch (err) {
      fail(err);
    }
    return true;
  }

  if (pathname === "/api/import/discard") {
    if (!kit.guard(req, res, "application/json")) return true;
    const body = await readJson();
    if (!body || typeof body.id !== "string") {
      kit.json(res, 400, { ok: false, error: "Body must be JSON with id." });
      return true;
    }
    kit.json(res, 200, { ok: true, discarded: importer.discard(body.id) });
    return true;
  }

  return false;
}

/** Streams a staged result to the <audio> player. Supports a single byte range so seeking works. */
async function sendPreview(importer: ImportService, id: string, req: IncomingMessage, res: ServerResponse, kit: RouteKit) {
  const p = importer.preview(id);
  if (!p) return kit.json(res, 404, { error: "Preview not found or expired" });

  let start = 0;
  let end = p.sizeBytes - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] !== "" || m[2] !== "")) {
      if (m[1] === "") start = Math.max(0, p.sizeBytes - Number(m[2]));
      else {
        start = Number(m[1]);
        if (m[2] !== "") end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= p.sizeBytes) {
        res.writeHead(416, { ...kit.headers, "Content-Range": `bytes */${p.sizeBytes}` }).end();
        return;
      }
      status = 206;
    }
  }

  const stream = createReadStream(p.path, { start, end });
  stream.once("open", () => {
    res.writeHead(status, {
      ...kit.headers,
      "Content-Type": p.mime,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${p.sizeBytes}` } : {}),
    });
    stream.pipe(res);
  });
  stream.once("error", () => {
    if (!res.headersSent) kit.json(res, 404, { error: "Preview not found or expired" });
    else res.destroy();
  });
  res.once("close", () => stream.destroy());
}
