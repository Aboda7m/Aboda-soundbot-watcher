import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, statSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { StremioService } from "./StremioService.ts";
import { TrackService } from "./TrackService.ts";
import { handleStremioRoute } from "./stremioRoutes.ts";
import { WatchManager } from "../watch/WatchManager.ts";

const have = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("viewers get subtitles and alternative audio through the track routes; watch room receives the track list", { skip: !have && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "trr-"));
  writeFileSync(join(dir, "a.srt"), "1\n00:00:01,000 --> 00:00:02,500\nHello track\n");
  const mkv = join(dir, "t.mkv");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-i", join(dir, "a.srt"),
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3", "-c:v", "mpeg4", "-c:a", "aac", "-c:s", "subrip", "-metadata:s:a:1", "language=eng", "-metadata:s:s:0", "language=eng", mkv]);
  const media = http.createServer((req, res) => { const size = statSync(mkv).size; res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes" }); createReadStream(mkv).pipe(res); });
  await new Promise<void>((r) => media.listen(0, "127.0.0.1", r));

  const tracks = new TrackService({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", dir: join(dir, "cache") });
  const svc = new StremioService({ addonUrls: [], serverUrl: "http://127.0.0.1:1", publicBase: "https://dash.example.com", tracks, log: () => undefined });
  const watch = new WatchManager();
  watch.updateVoice({ guildId: "111111111111111", guildName: "G", userId: "222222222222222", username: "u", channelId: "333333333333333", channelName: "V" });
  const room = watch.getRoom("111111111111111", "333333333333333")!;
  const json = (res: http.ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const front = http.createServer(async (req, res) => {
    const handled = await handleStremioRoute(svc, req, res, new URL(req.url ?? "/", "http://x"), { json, guard: () => true, readBody: async () => "", headers: { "Cache-Control": "no-store" }, userId: "222222222222222", allowed: false, watch });
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  try {
    const tid = tracks.register(`http://127.0.0.1:${(media.address() as AddressInfo).port}/t.mkv`);
    // room state: tracks are attached only while the same media is playing
    watch.command(room, "222222222222222", { action: "media", url: "https://dash.example.com/api/stremio/s/x/y.mkv", title: "T" });
    const info = await tracks.probe(tid);
    watch.setTracks(room, "https://other.example.com/zzz.mp4", info);
    assert.equal(room.media?.tracks, undefined);
    watch.setTracks(room, "https://dash.example.com/api/stremio/s/x/y.mkv", info);
    assert.equal(watch.snapshot(room).media?.tracks?.subs.length, 1);

    // viewer (no stremio permission) can fetch the tracks
    const vtt = await fetch(`${base}/api/stremio/t/${tid}/sub-0.vtt`);
    assert.equal(vtt.status, 200); assert.match(vtt.headers.get("content-type") ?? "", /text\/vtt/); assert.equal(vtt.headers.get("cache-control"), "private, max-age=3600");
    assert.match(await vtt.text(), /Hello track/);
    assert.equal((await fetch(`${base}/api/stremio/t/${tid}/sub-5.vtt`)).status, 404);
    assert.equal((await fetch(`${base}/api/stremio/t/${"a".repeat(32)}/sub-0.vtt`)).status, 404);
    assert.equal((await fetch(`${base}/api/stremio/t/${tid}/sub-0.vtt`, { method: "POST" })).status, 405);

    let a = await fetch(`${base}/api/stremio/t/${tid}/audio-1.m4a`, { headers: { Range: "bytes=0-0" } });
    for (let i = 0; i < 100 && a.status === 202; i++) { await new Promise((r) => setTimeout(r, 100)); a = await fetch(`${base}/api/stremio/t/${tid}/audio-1.m4a`, { headers: { Range: "bytes=0-0" } }); }
    assert.equal(a.status, 206); assert.match(a.headers.get("content-range") ?? "", /^bytes 0-0\/\d+$/); assert.equal(a.headers.get("content-type"), "audio/mp4");
    const full = await fetch(`${base}/api/stremio/t/${tid}/audio-1.m4a`);
    assert.equal(full.status, 200); assert.equal((await full.arrayBuffer()).byteLength, Number(full.headers.get("content-length")));
    assert.equal((await fetch(`${base}/api/stremio/t/${tid}/audio-1.m4a`, { headers: { Range: "bytes=999999999-" } })).status, 416);
  } finally { for (const s of [front, media]) { s.closeAllConnections(); s.close(); } watch.close(); tracks.close(); }
});
