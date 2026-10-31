import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Stremio addon protocol client + a small authenticated proxy to a local Stremio streaming server.
 *
 *  - Catalog / meta / stream data come from Stremio addons (Kitsu for anime, Cinemeta, Torrentio ...), found through their manifests.
 *  - A stream is either a direct https URL (debrid / HTTP sources) or a torrent (infoHash). Torrents are played by the
 *    Stremio streaming server (default http://127.0.0.1:11470); the bot never talks BitTorrent itself.
 *  - Viewers are remote, so a torrent stream is exposed through /api/stremio/s/<id>/..., which needs a dashboard session and
 *    can only reach the two path shapes this module registered itself. The streaming server is never exposed directly.
 */

export class StremioError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

interface ResourceDecl { name: string; types?: string[]; idPrefixes?: string[] }
interface CatalogDecl { type: string; id: string; name?: string; extra?: { name: string; isRequired?: boolean }[]; extraSupported?: string[]; extraRequired?: string[] }
export interface Manifest {
  id?: string; name?: string; types?: string[]; idPrefixes?: string[];
  resources?: (string | ResourceDecl)[]; catalogs?: CatalogDecl[];
}
export interface Addon { base: string; name: string; manifest: Manifest }

export interface MetaPreview { id: string; type: string; name: string; poster?: string; year?: string; description?: string; source: string }
export interface Video { id: string; title: string; season: number; episode: number; released?: string; thumbnail?: string }
export interface MetaDetail extends MetaPreview { background?: string; genres?: string[]; videos: Video[] }
export interface StreamItem {
  ref: string; addon: string; kind: "torrent" | "url"; name: string; title: string;
  quality?: string; size?: string; seeders?: number; filename?: string;
}
export interface Playback { url: string; title: string; mode: "direct" | "torrent" | "torrent-hls" }

interface RawStream {
  url?: string; infoHash?: string; fileIdx?: number; sources?: string[];
  name?: string; title?: string; description?: string;
  behaviorHints?: { filename?: string; videoSize?: number };
}
type ProxyEntry =
  | { kind: "raw"; path: string; filename: string; expires: number }
  | { kind: "hls"; base: string; masterQuery: string; expires: number };

export interface StremioOptions {
  addonUrls: string[];
  serverUrl: string;
  /** Public https origin viewers use (PUBLIC_BASE_URL). */
  publicBase: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  refTtlMs?: number;
  proxyTtlMs?: number;
  manifestTtlMs?: number;
  requestTimeoutMs?: number;
}

const enc = encodeURIComponent;
const HASH = /^[0-9a-f]{40}$/;
const SAFE_SUBPATH = /^[A-Za-z0-9._\-/]{1,200}$/;
const SAFE_QUERY = /^\?[A-Za-z0-9_=&.%-]{0,200}$/;

export const normalizeAddonUrl = (raw: string): string => {
  const u = new URL(raw.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`Unsupported addon URL: ${raw}`);
  return `${u.origin}${u.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "")}`;
};

const matchesPrefix = (id: string, prefixes?: string[]) => !prefixes || prefixes.length === 0 || prefixes.some((p) => id.startsWith(p));

/** Does this addon offer `resource` for this content type (and id, when the manifest restricts id prefixes)? */
export function supports(m: Manifest, resource: string, type: string, id?: string): boolean {
  for (const r of m.resources ?? []) {
    if (typeof r === "string") {
      if (r !== resource) continue;
      if (m.types && !m.types.includes(type)) continue;
      if (id !== undefined && !matchesPrefix(id, m.idPrefixes)) continue;
      return true;
    }
    if (r.name !== resource) continue;
    const types = r.types ?? m.types;
    if (types && !types.includes(type)) continue;
    if (id !== undefined && !matchesPrefix(id, r.idPrefixes ?? m.idPrefixes)) continue;
    return true;
  }
  return false;
}

/** A catalog can be searched when it supports the `search` extra and requires nothing else. */
export function catalogSearchable(c: CatalogDecl): boolean {
  const names = [...(c.extra?.map((e) => e.name) ?? []), ...(c.extraSupported ?? [])];
  if (!names.includes("search")) return false;
  const otherRequired = (c.extra ?? []).some((e) => e.isRequired && e.name !== "search") || (c.extraRequired ?? []).some((n) => n !== "search");
  return !otherRequired;
}

const str = (v: unknown, max = 500): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const httpsUrl = (v: unknown): string | undefined => {
  const s = str(v, 1000);
  if (!s) return undefined;
  try { return new URL(s).protocol === "https:" ? s : undefined; } catch { return undefined; }
};

export function parseStream(raw: RawStream, addon: string, ref: string): StreamItem | null {
  const url = raw.url ? httpsUrl(raw.url) : undefined;
  const hash = typeof raw.infoHash === "string" ? raw.infoHash.toLowerCase() : "";
  if (!url && !HASH.test(hash)) return null;
  const nameLines = String(raw.name ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const text = String(raw.title ?? raw.description ?? "");
  const titleLines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  const blob = `${raw.name ?? ""}\n${text}`;
  const quality = blob.match(/\b(2160p|4k|1440p|1080p|720p|480p|360p)\b/i)?.[1]?.toLowerCase();
  const seeders = Number(text.match(/👤\s*(\d+)/)?.[1]);
  const size = text.match(/💾\s*([\d.]+\s*[KMGT]i?B)/i)?.[1];
  const filename = str(raw.behaviorHints?.filename, 200);
  return {
    ref, addon, kind: url ? "url" : "torrent",
    name: nameLines.join(" · ") || addon,
    title: titleLines[0] ?? filename ?? "Stream",
    ...(quality ? { quality } : {}),
    ...(size ? { size } : {}),
    ...(Number.isFinite(seeders) ? { seeders } : {}),
    ...(filename ? { filename } : {}),
  };
}

const yearOf = (m: Record<string, unknown>): string | undefined => str(m.releaseInfo, 20) ?? (m.year !== undefined ? str(String(m.year), 20) : undefined);

const previewOf = (m: Record<string, unknown>, fallbackType: string, source: string): MetaPreview | null => {
  const id = str(m.id, 120); const name = str(m.name, 200);
  if (!id || !name) return null;
  return {
    id, name, type: str(m.type, 30) ?? fallbackType, source,
    ...(httpsUrl(m.poster) ? { poster: httpsUrl(m.poster)! } : {}),
    ...(yearOf(m) ? { year: yearOf(m)! } : {}),
    ...(str(m.description, 600) ? { description: str(m.description, 600)! } : {}),
  };
};

export class StremioService {
  #opts: Required<Pick<StremioOptions, "refTtlMs" | "proxyTtlMs" | "manifestTtlMs" | "requestTimeoutMs">> & StremioOptions;
  #addons: { at: number; list: Addon[] } | null = null;
  #refs = new Map<string, { stream: RawStream; addon: string; expires: number }>();
  #proxies = new Map<string, ProxyEntry>();
  #fetch: typeof fetch;

  constructor(opts: StremioOptions) {
    this.#opts = { refTtlMs: 30 * 60_000, proxyTtlMs: 12 * 3_600_000, manifestTtlMs: 10 * 60_000, requestTimeoutMs: 15_000, ...opts };
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  get serverUrl() { return this.#opts.serverUrl; }

  async #json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const r = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#opts.requestTimeoutMs), headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > 5_000_000) throw new Error("response too large");
    return JSON.parse(text) as Record<string, unknown>;
  }

  async addons(): Promise<Addon[]> {
    const now = Date.now();
    if (this.#addons && now - this.#addons.at < this.#opts.manifestTtlMs) return this.#addons.list;
    const out: Addon[] = [];
    await Promise.all(this.#opts.addonUrls.map(async (raw) => {
      try {
        const base = normalizeAddonUrl(raw);
        const manifest = (await this.#json(`${base}/manifest.json`)) as Manifest;
        out.push({ base, manifest, name: str(manifest.name, 60) ?? new URL(base).hostname });
      } catch (err) {
        this.#opts.log?.(`Stremio addon unavailable (${raw.split("?")[0]}): ${(err as Error).message}`);
      }
    }));
    // keep the configured order
    const order = new Map(this.#opts.addonUrls.map((u, i) => { try { return [normalizeAddonUrl(u), i] as const; } catch { return [u, i] as const; } }));
    out.sort((a, b) => (order.get(a.base) ?? 0) - (order.get(b.base) ?? 0));
    if (out.length) this.#addons = { at: now, list: out };
    return out;
  }

  async search(query: string): Promise<MetaPreview[]> {
    const q = query.trim().slice(0, 100);
    if (!q) return [];
    const jobs: Promise<MetaPreview[]>[] = [];
    for (const a of await this.addons()) {
      for (const c of a.manifest.catalogs ?? []) {
        if (!catalogSearchable(c)) continue;
        jobs.push(this.#json(`${a.base}/catalog/${enc(c.type)}/${enc(c.id)}/search=${enc(q)}.json`).then((j) =>
          (Array.isArray(j.metas) ? j.metas : []).slice(0, 25).map((m) => previewOf(m as Record<string, unknown>, c.type, a.name)).filter((m): m is MetaPreview => !!m)));
      }
    }
    const seen = new Set<string>(); const out: MetaPreview[] = [];
    for (const res of await Promise.allSettled(jobs)) {
      if (res.status !== "fulfilled") continue;
      for (const m of res.value) { const k = `${m.type}:${m.id}`; if (!seen.has(k)) { seen.add(k); out.push(m); } }
    }
    return out;
  }

  async meta(type: string, id: string): Promise<MetaDetail> {
    for (const a of await this.addons()) {
      if (!supports(a.manifest, "meta", type, id)) continue;
      try {
        const j = await this.#json(`${a.base}/meta/${enc(type)}/${id.split(":").map(enc).join(":")}.json`);
        const m = j.meta as Record<string, unknown> | undefined;
        const base = m && previewOf(m, type, a.name);
        if (!m || !base) continue;
        const videos: Video[] = (Array.isArray(m.videos) ? m.videos : []).slice(0, 3000).flatMap((v: Record<string, unknown>) => {
          const vid = str(v.id, 120); if (!vid) return [];
          const season = Number(v.season ?? 1) || 0; const episode = Number(v.episode ?? v.number ?? 0) || 0;
          return [{ id: vid, season, episode, title: str(v.title ?? v.name, 200) ?? `Episode ${episode}`, ...(str(v.released, 40) ? { released: str(v.released, 40)! } : {}), ...(httpsUrl(v.thumbnail) ? { thumbnail: httpsUrl(v.thumbnail)! } : {}) }];
        }).sort((x, y) => x.season - y.season || x.episode - y.episode);
        return {
          ...base,
          ...(httpsUrl(m.background) ? { background: httpsUrl(m.background)! } : {}),
          ...(Array.isArray(m.genres) ? { genres: m.genres.filter((g): g is string => typeof g === "string").slice(0, 8) } : {}),
          videos: videos.length ? videos : [{ id: base.id, title: base.name, season: 0, episode: 0 }],
        };
      } catch (err) {
        this.#opts.log?.(`Stremio meta failed on ${a.name}: ${(err as Error).message}`);
      }
    }
    throw new StremioError(404, "No addon returned details for this title.");
  }

  async streams(type: string, videoId: string): Promise<StreamItem[]> {
    this.#sweep();
    const jobs: Promise<StreamItem[]>[] = [];
    for (const a of await this.addons()) {
      if (!supports(a.manifest, "stream", type, videoId)) continue;
      jobs.push(this.#json(`${a.base}/stream/${enc(type)}/${videoId.split(":").map(enc).join(":")}.json`).then((j) => {
        const items: StreamItem[] = [];
        for (const raw of (Array.isArray(j.streams) ? j.streams : []).slice(0, 80) as RawStream[]) {
          const ref = randomBytes(12).toString("hex");
          const item = parseStream(raw, a.name, ref);
          if (!item) continue;
          this.#refs.set(ref, { stream: raw, addon: a.name, expires: Date.now() + this.#opts.refTtlMs });
          items.push(item);
        }
        return items;
      }));
    }
    if (!jobs.length) throw new StremioError(404, "No stream addon supports this title.");
    const all: StreamItem[] = [];
    for (const r of await Promise.allSettled(jobs)) if (r.status === "fulfilled") all.push(...r.value);
    // direct links first (they need no torrenting), then by seeders
    return all.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "url" ? -1 : 1) || (b.seeders ?? 0) - (a.seeders ?? 0));
  }

  async #reachable(): Promise<void> {
    try { await this.#fetch(`${this.serverUrl}/settings`, { signal: AbortSignal.timeout(4000) }); }
    catch { throw new StremioError(503, `The Stremio streaming server is not reachable at ${this.serverUrl}. Start Stremio (or stremio-service) on the bot's PC.`); }
  }

  /** Turn a stream the user picked into a URL that every viewer's browser can load. */
  async play(ref: string, opts: { transcode?: boolean } = {}): Promise<Playback> {
    this.#sweep();
    const hit = this.#refs.get(ref);
    if (!hit) throw new StremioError(410, "That stream expired. Search the episode again.");
    const s = hit.stream;
    const parsed = parseStream(s, hit.addon, ref);
    const title = (parsed?.title ?? "Stream").slice(0, 180);

    const direct = s.url ? httpsUrl(s.url) : undefined;
    if (direct) return { url: direct, title, mode: "direct" };

    const hash = String(s.infoHash ?? "").toLowerCase();
    if (!HASH.test(hash)) throw new StremioError(400, "This stream cannot be played.");
    if (!this.#opts.publicBase.startsWith("https://")) throw new StremioError(400, "PUBLIC_BASE_URL must be https so viewers can load the stream.");
    await this.#reachable();

    const idx = Number.isInteger(s.fileIdx) && (s.fileIdx as number) >= 0 ? (s.fileIdx as number) : 0;
    const sources = Array.isArray(s.sources) ? s.sources.filter((x): x is string => typeof x === "string").slice(0, 60) : [];
    // Best effort: tell the streaming server which trackers to use. Playing works without it, so errors are ignored.
    await this.#fetch(`${this.serverUrl}/${hash}/create`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ torrent: { infoHash: hash }, peerSearch: { sources: [`dht:${hash}`, ...sources.filter((x) => x.startsWith("tracker:"))], min: 40, max: 150 } }),
    }).catch(() => undefined);

    const id = randomBytes(16).toString("hex");
    const filename = (parsed?.filename ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
    const expires = Date.now() + this.#opts.proxyTtlMs;
    const rawPath = `/${hash}/${idx}`;
    if (opts.transcode) {
      const session = randomBytes(16).toString("hex");
      const q = new URLSearchParams();
      q.set("mediaURL", `${this.serverUrl}${rawPath}`);
      q.append("videoCodecs", "h264"); q.append("audioCodecs", "aac"); q.set("maxAudioChannels", "2");
      this.#addProxy(id, { kind: "hls", base: `/hlsv2/${session}/`, masterQuery: q.toString(), expires });
      return { url: `${this.#opts.publicBase}/api/stremio/s/${id}/master.m3u8`, title, mode: "torrent-hls" };
    }
    this.#addProxy(id, { kind: "raw", path: rawPath, filename: filename || "stream", expires });
    return { url: `${this.#opts.publicBase}/api/stremio/s/${id}/${filename || "stream"}`, title, mode: "torrent" };
  }

  #addProxy(id: string, e: ProxyEntry) {
    if (this.#proxies.size >= 50) { const oldest = this.#proxies.keys().next().value; if (oldest) this.#proxies.delete(oldest); }
    this.#proxies.set(id, e);
  }

  #sweep() {
    const now = Date.now();
    for (const [k, v] of this.#refs) if (v.expires < now) this.#refs.delete(k);
    for (const [k, v] of this.#proxies) if (v.expires < now) this.#proxies.delete(k);
  }

  /** GET/HEAD /api/stremio/s/<id>/<sub>: stream from the local server, honouring Range so seeking works. */
  serveProxy(id: string, sub: string, req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): void {
    this.#sweep();
    const fail = (status: number, msg: string) => { if (!res.headersSent) res.writeHead(status, { ...headers, "Content-Type": "text/plain; charset=utf-8" }); res.end(msg); };
    const e = this.#proxies.get(id);
    if (!e) return fail(404, "Stream expired");

    let path: string; let fallbackType = "application/octet-stream";
    if (e.kind === "raw") {
      path = e.path;
      fallbackType = /\.mp4$/i.test(e.filename) ? "video/mp4" : /\.webm$/i.test(e.filename) ? "video/webm" : "video/x-matroska";
    } else if (sub === "master.m3u8") {
      path = `${e.base}master.m3u8?${e.masterQuery}`; fallbackType = "application/vnd.apple.mpegurl";
    } else {
      if (!SAFE_SUBPATH.test(sub) || sub.split("/").some((p) => p === ".." || p === "." || p === "")) return fail(400, "Bad path");
      const qs = new URL(req.url ?? "/", "http://x").search;
      if (qs && !SAFE_QUERY.test(qs)) return fail(400, "Bad query");
      path = `${e.base}${sub}${qs}`;
      if (sub.endsWith(".m3u8")) fallbackType = "application/vnd.apple.mpegurl";
      else if (sub.endsWith(".ts")) fallbackType = "video/mp2t";
      else if (sub.endsWith(".mp4") || sub.endsWith(".m4s")) fallbackType = "video/mp4";
      else if (sub.endsWith(".vtt")) fallbackType = "text/vtt";
    }

    const target = new URL(this.serverUrl + path);
    const lib = target.protocol === "https:" ? https : http;
    const fwd: Record<string, string> = {};
    for (const h of ["range", "if-range", "if-none-match", "if-modified-since"] as const) { const v = req.headers[h]; if (typeof v === "string") fwd[h] = v; }
    const up = lib.request(target, { method: req.method === "HEAD" ? "HEAD" : "GET", headers: fwd, timeout: 60_000 }, (r) => {
      const out: Record<string, string> = { ...headers, "Content-Type": String(r.headers["content-type"] || fallbackType), "Accept-Ranges": "bytes" };
      for (const h of ["content-length", "content-range", "last-modified", "etag"] as const) { const v = r.headers[h]; if (typeof v === "string") out[h] = v; }
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
      r.on("error", () => res.destroy());
    });
    up.on("timeout", () => up.destroy(new Error("upstream timeout")));
    up.on("error", (err) => { this.#opts.log?.(`Stremio proxy error: ${err.message}`); fail(502, "Streaming server error"); });
    res.on("close", () => up.destroy());
    up.end();
  }
}
