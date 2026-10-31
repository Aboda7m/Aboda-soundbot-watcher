import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { StremioService, StremioError, supports, catalogSearchable, parseStream, normalizeAddonUrl } from "./StremioService.ts";

const HASH = "a".repeat(40);
const kitsu = { name: "Kitsu", types: ["anime"], idPrefixes: ["kitsu"], resources: ["catalog", "meta"], catalogs: [
  { type: "anime", id: "trending", extra: [{ name: "skip" }] },
  { type: "anime", id: "list", extra: [{ name: "search", isRequired: false }, { name: "skip" }] },
  { type: "anime", id: "genre-only", extra: [{ name: "search" }, { name: "genre", isRequired: true }] },
] };
const torrentio = { name: "Torrentio", types: ["movie", "series", "anime"], idPrefixes: ["tt", "kitsu"], resources: ["stream"], catalogs: [] };

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200 });
  }) as typeof fetch;
}

test("addon urls are normalised (manifest suffix, trailing slash) and non-http is refused", () => {
  assert.equal(normalizeAddonUrl("https://x.test/a/manifest.json"), "https://x.test/a");
  assert.equal(normalizeAddonUrl("https://x.test/"), "https://x.test");
  assert.throws(() => normalizeAddonUrl("file:///etc/passwd"));
});

test("resource support honours types and id prefixes", () => {
  assert.ok(supports(torrentio, "stream", "anime", "kitsu:1:2"));
  assert.ok(!supports(torrentio, "stream", "channel", "tt1"));
  assert.ok(!supports(torrentio, "stream", "movie", "xx1"));
  assert.ok(supports({ types: ["movie"], resources: [{ name: "stream", types: ["movie"], idPrefixes: ["yt"] }] }, "stream", "movie", "yt:1"));
  assert.ok(!supports(kitsu, "stream", "anime", "kitsu:1"));
});

test("only catalogs that search and require nothing else are searchable", () => {
  const [trending, list, genreOnly] = kitsu.catalogs;
  assert.ok(!catalogSearchable(trending!)); assert.ok(catalogSearchable(list!)); assert.ok(!catalogSearchable(genreOnly!));
  assert.ok(catalogSearchable({ type: "movie", id: "top", extraSupported: ["search", "genre"] }));
});

test("Torrentio-style streams are parsed; unplayable ones are dropped", () => {
  const s = parseStream({ infoHash: HASH.toUpperCase(), name: "Torrentio\n1080p", title: "[Grp] Show - 01.mkv\n👤 321 💾 1.40 GB ⚙️ Nyaa", behaviorHints: { filename: "Show - 01.mkv" } }, "Torrentio", "r1")!;
  assert.equal(s.kind, "torrent"); assert.equal(s.quality, "1080p"); assert.equal(s.seeders, 321); assert.equal(s.size, "1.40 GB");
  assert.equal(parseStream({ url: "http://insecure.test/a.mp4" }, "x", "r")!, null);
  assert.equal(parseStream({ externalUrl: "https://x" } as never, "x", "r"), null);
  assert.equal(parseStream({ infoHash: "short" }, "x", "r"), null);
  assert.equal(parseStream({ url: "https://cdn.test/a.mp4" }, "x", "r")!.kind, "url");
});

function service(extra: Record<string, unknown> = {}, calls: string[] = [], serverUrl = "http://127.0.0.1:1") {
  return new StremioService({
    addonUrls: ["https://kitsu.test/manifest.json", "https://torrentio.test/manifest.json"], serverUrl, publicBase: "https://dash.example.com",
    fetchImpl: fakeFetch({
      "kitsu.test/manifest.json": kitsu, "torrentio.test/manifest.json": torrentio,
      "/catalog/anime/list/search=frieren.json": { metas: [{ id: "kitsu:46474", type: "anime", name: "Frieren", poster: "https://img.test/p.jpg", releaseInfo: "2023" }, { name: "no id" }] },
      "/meta/anime/kitsu:46474.json": { meta: { id: "kitsu:46474", type: "anime", name: "Frieren", videos: [{ id: "kitsu:46474:2", season: 1, episode: 2, title: "Ep 2" }, { id: "kitsu:46474:1", season: 1, episode: 1 }] } },
      "/stream/anime/kitsu:46474:1.json": { streams: [
        { infoHash: HASH, fileIdx: 3, title: "A\n👤 5", sources: ["tracker:udp://t.test:80", "dht:" + HASH] },
        { url: "https://cdn.test/ep1.mp4", title: "B\n👤 1" },
        { infoHash: "b".repeat(40), title: "C\n👤 50" },
      ] },
      ...extra,
    }, calls),
    log: () => undefined,
  });
}

test("search discovers searchable catalogs, dedupes and drops malformed entries", async () => {
  const res = await service().search("frieren");
  assert.deepEqual(res.map((m) => [m.id, m.name, m.year]), [["kitsu:46474", "Frieren", "2023"]]);
});

test("meta sorts episodes; streams list direct links first, then by seeders", async () => {
  const svc = service();
  const meta = await svc.meta("anime", "kitsu:46474");
  assert.deepEqual(meta.videos.map((v) => v.id), ["kitsu:46474:1", "kitsu:46474:2"]);
  const streams = await svc.streams("anime", "kitsu:46474:1");
  assert.deepEqual(streams.map((s) => s.kind), ["url", "torrent", "torrent"]);
  assert.deepEqual(streams.filter((s) => s.kind === "torrent").map((s) => s.seeders), [50, 5]);
  await assert.rejects(() => svc.meta("anime", "tt999"), (e: unknown) => e instanceof StremioError && e.status === 404);
});

test("play: direct https link is returned as-is; unknown ref is rejected", async () => {
  const svc = service(); const streams = await svc.streams("anime", "kitsu:46474:1");
  const p = await svc.play(streams[0]!.ref);
  assert.equal(p.url, "https://cdn.test/ep1.mp4"); assert.equal(p.mode, "direct");
  await assert.rejects(() => svc.play("nope"), (e: unknown) => e instanceof StremioError && e.status === 410);
});

test("play: torrent needs a reachable streaming server (503 otherwise)", async () => {
  const svc = new StremioService({ addonUrls: ["https://kitsu.test/manifest.json", "https://torrentio.test/manifest.json"], serverUrl: "http://127.0.0.1:1", publicBase: "https://dash.example.com",
    fetchImpl: (async (input: string | URL | Request) => { const u = String(input); if (u.includes("127.0.0.1")) throw new Error("ECONNREFUSED"); return new Response(JSON.stringify(u.includes("torrentio.test/manifest") ? torrentio : u.includes("kitsu.test/manifest") ? kitsu : { streams: [{ infoHash: HASH, title: "x" }] })); }) as typeof fetch, log: () => undefined });
  const [s] = await svc.streams("anime", "kitsu:1:1");
  await assert.rejects(() => svc.play(s!.ref), (e: unknown) => e instanceof StremioError && e.status === 503);
});

test("torrent proxy relays Range requests and only to the registered path", async () => {
  const seen: string[] = [];
  const body = Buffer.from("0123456789".repeat(100));
  const upstream = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} range=${req.headers.range ?? ""}`);
    if (req.url === `/${HASH}/3`) {
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      if (m) { const a = Number(m[1]); const b = m[2] ? Number(m[2]) : body.length - 1; res.writeHead(206, { "Content-Type": "video/x-matroska", "Content-Range": `bytes ${a}-${b}/${body.length}`, "Content-Length": String(b - a + 1) }); return void res.end(body.subarray(a, b + 1)); }
      res.writeHead(200, { "Content-Type": "video/x-matroska", "Content-Length": String(body.length) }); return void res.end(body);
    }
    res.writeHead(200).end("settings");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const svc = service({}, [], `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  const streams = await svc.streams("anime", "kitsu:46474:1");
  const torrent = streams.find((s) => s.kind === "torrent" && s.seeders === 5)!;
  const play = await svc.play(torrent.ref);
  assert.equal(play.mode, "torrent");
  const m = /\/api\/stremio\/s\/([0-9a-f]{32})\/(.+)$/.exec(play.url)!;
  assert.ok(m);

  const front = http.createServer((req, res) => svc.serveProxy(m[1]!, req.url === "/bad" ? "../x" : m[2]!, req, res, { "X-Test": "1" }));
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  const r = await fetch(`${base}/`, { headers: { Range: "bytes=10-19" } });
  assert.equal(r.status, 206); assert.equal(r.headers.get("content-range"), "bytes 10-19/1000"); assert.equal(r.headers.get("x-test"), "1");
  assert.equal(await r.text(), "0123456789");
  assert.ok(seen.some((l) => l === `GET /${HASH}/3 range=bytes=10-19`));
  // unknown id => 404, never reaches the upstream
  const before = seen.length;
  const front2 = http.createServer((req, res) => svc.serveProxy("f".repeat(32), "x", req, res, {}));
  await new Promise<void>((r2) => front2.listen(0, "127.0.0.1", r2));
  assert.equal((await fetch(`http://127.0.0.1:${(front2.address() as AddressInfo).port}/`)).status, 404);
  assert.equal(seen.length, before);
  for (const s of [front, front2, upstream]) { s.closeAllConnections(); s.close(); }
});

test("transcode mode exposes an HLS master playlist and confines sub-paths", async () => {
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => { seen.push(req.url ?? ""); res.writeHead(200, { "Content-Type": "text/plain" }).end("#EXTM3U"); });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const svc = service({}, [], `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  const t = (await svc.streams("anime", "kitsu:46474:1")).find((s) => s.kind === "torrent" && s.seeders === 5)!;
  const play = await svc.play(t.ref, { transcode: true });
  assert.equal(play.mode, "torrent-hls"); assert.match(play.url, /\/master\.m3u8$/);
  const id = /\/s\/([0-9a-f]{32})\//.exec(play.url)![1]!;
  let sub = "master.m3u8";
  const front = http.createServer((req, res) => svc.serveProxy(id, sub, req, res, {}));
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(front.address() as AddressInfo).port}/`;
  assert.equal((await fetch(url)).status, 200);
  assert.match(seen[0]!, /^\/hlsv2\/[0-9a-f]{32}\/master\.m3u8\?mediaURL=http%3A%2F%2F127\.0\.0\.1%3A\d+%2F[a]{40}%2F\d&videoCodecs=h264&audioCodecs=aac&maxAudioChannels=2$/);
  sub = "stream-0/seg1.ts"; assert.equal((await fetch(url)).status, 200); assert.match(seen[1]!, /^\/hlsv2\/[0-9a-f]{32}\/stream-0\/seg1\.ts$/);
  const n = seen.length;
  for (const bad of ["../../settings", "a/../b", "x y", "/abs"]) { sub = bad; assert.equal((await fetch(url)).status, 400, bad); }
  assert.equal(seen.length, n);
  for (const s of [front, upstream]) { s.closeAllConnections(); s.close(); }
});
