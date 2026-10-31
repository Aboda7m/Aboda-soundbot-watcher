import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { StremioService } from "./StremioService.ts";
import { handleStremioRoute } from "./stremioRoutes.ts";
import { WatchManager } from "../watch/WatchManager.ts";

const manifests: Record<string, unknown> = {
  "kitsu.test/manifest.json": { name: "Kitsu", types: ["anime"], idPrefixes: ["kitsu"], resources: ["catalog", "meta"], catalogs: [{ type: "anime", id: "list", extra: [{ name: "search" }] }] },
  "torrentio.test/manifest.json": { name: "Torrentio", types: ["anime"], idPrefixes: ["kitsu"], resources: ["stream"] },
  "/catalog/anime/list/search=x1.json": { metas: [{ id: "kitsu:1", type: "anime", name: "X1" }] },
  "/stream/anime/kitsu:1:1.json": { streams: [{ url: "https://cdn.test/a.mp4", title: "Direct\n1080p" }] },
};
const fetchImpl = (async (input: string | URL | Request) => {
  const hit = Object.entries(manifests).find(([k]) => String(input).includes(k));
  return hit ? new Response(JSON.stringify(hit[1])) : new Response("", { status: 404 });
}) as typeof fetch;

async function boot(allowed: boolean, inRoom = true) {
  const svc = new StremioService({ addonUrls: ["https://kitsu.test/manifest.json", "https://torrentio.test/manifest.json"], serverUrl: "http://127.0.0.1:1", publicBase: "https://dash.example.com", fetchImpl, log: () => undefined });
  const watch = new WatchManager();
  if (inRoom) watch.updateVoice({ guildId: "111111111111111", guildName: "G", userId: "222222222222222", username: "u", channelId: "333333333333333", channelName: "Voice" });
  const json = (res: http.ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = async () => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c).toString(); };
    const handled = await handleStremioRoute(svc, req, res, url, { json, guard: () => true, readBody: body, headers: {}, userId: "222222222222222", allowed, watch });
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => { server.closeAllConnections(); server.close(); watch.close(); };
  return { base, watch, close };
}

test("without the stremio permission every API route is 403, but not-ours paths are untouched", async () => {
  const { base, close } = await boot(false);
  assert.equal((await fetch(`${base}/api/stremio/search?q=x1`)).status, 403);
  assert.equal((await fetch(`${base}/api/stremio/play`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/api/other`)).status, 404);
  close();
});

test("with permission: search, streams, and play sends the media to the watch room", async () => {
  const { base, watch, close } = await boot(true);
  const search = await (await fetch(`${base}/api/stremio/search?q=x1`)).json() as { results: { id: string }[] };
  assert.equal(search.results[0]!.id, "kitsu:1");
  assert.equal((await fetch(`${base}/api/stremio/streams?type=anime&id=../etc`)).status, 400);
  const { streams } = await (await fetch(`${base}/api/stremio/streams?type=anime&id=kitsu:1:1`)).json() as { streams: { ref: string }[] };
  const ok = await fetch(`${base}/api/stremio/play`, { method: "POST", body: JSON.stringify({ ref: streams[0]!.ref, guildId: "111111111111111", channelId: "333333333333333" }) });
  assert.equal(ok.status, 200);
  const room = watch.getRoom("111111111111111", "333333333333333")!;
  assert.equal(room.media?.url, "https://cdn.test/a.mp4"); assert.equal(room.media?.kind, "html5");
  // wrong room => refused, nothing changes
  const bad = await fetch(`${base}/api/stremio/play`, { method: "POST", body: JSON.stringify({ ref: streams[0]!.ref, guildId: "1", channelId: "2" }) });
  assert.equal(bad.status, 403);
  close();
});

test("play is refused when the user is not in the voice channel", async () => {
  const { base, close } = await boot(true, false);
  const r = await fetch(`${base}/api/stremio/play`, { method: "POST", body: JSON.stringify({ ref: "x", guildId: "111111111111111", channelId: "333333333333333" }) });
  assert.equal(r.status, 403);
  close();
});

test("the stream proxy path needs no stremio permission (it is for viewers) but unknown ids are 404", async () => {
  const { base, close } = await boot(false);
  assert.equal((await fetch(`${base}/api/stremio/s/${"a".repeat(32)}/video.mkv`)).status, 404);
  assert.equal((await fetch(`${base}/api/stremio/s/${"a".repeat(32)}/video.mkv`, { method: "POST", body: "" })).status, 405);
  close();
});
