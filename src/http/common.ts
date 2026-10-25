import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

/** Helpers shared by the public and the local listener. Nothing in here knows about authentication. */

export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src https://cdn.discordapp.com; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export const SNOWFLAKE = /^\d{15,25}$/;
export const MAX_BODY = 2048;

/** Constant-time comparison that also hides the length of the secret. */
export const safeEqual = (a: string, b: string): boolean => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

export function json(res: ServerResponse, status: number, body: unknown) {
  res
    .writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json" })
    .end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<string> {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Rejects a state-changing request unless it uses the expected non-form content type (forces a CORS preflight). */
export function contentTypeAllowed(req: IncomingMessage, res: ServerResponse, contentType: string): boolean {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== contentType) {
    json(res, 415, { error: `Content-Type must be ${contentType}` });
    return false;
  }
  return true;
}

export const isLoopbackHost = (host: string): boolean =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
