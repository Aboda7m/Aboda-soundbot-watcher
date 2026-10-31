import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TrackService, languageName } from "./TrackService.ts";

const have = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("language names", () => {
  assert.equal(languageName("jpn"), "Japanese"); assert.equal(languageName("eng"), "English");
  assert.equal(languageName("ger"), "German"); assert.equal(languageName("und"), "Unknown");
});

test("probe lists tracks, subtitles become WebVTT, alternative audio is converted on demand", { skip: !have && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "trk-"));
  writeFileSync(join(dir, "a.ass"), `[Script Info]\nScriptType: v4.00+\nPlayResX: 160\nPlayResY: 90\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,12,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,5,5,5,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,Hello from ASS\n`);
  writeFileSync(join(dir, "b.srt"), `1\n00:00:01,000 --> 00:00:02,500\nBonjour SRT\n`);
  const mkv = join(dir, "t.mkv");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:d=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-f", "lavfi", "-i", "sine=frequency=880:duration=4",
    "-i", join(dir, "a.ass"), "-i", join(dir, "b.srt"),
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3", "-map", "4", "-c:v", "mpeg4", "-c:a", "aac", "-c:s:0", "ass", "-c:s:1", "subrip",
    "-metadata:s:a:0", "language=jpn", "-metadata:s:a:1", "language=eng", "-metadata:s:a:1", "title=English Dub", "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=fre", mkv]);

  const server = http.createServer((req, res) => {   // range-capable file server, like the streaming server
    const size = statSync(mkv).size; const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (m) { const a = +m[1]!; const b = m[2] ? +m[2] : size - 1; res.writeHead(206, { "Content-Range": `bytes ${a}-${b}/${size}`, "Content-Length": b - a + 1, "Accept-Ranges": "bytes", "Content-Type": "video/x-matroska" }); createReadStream(mkv, { start: a, end: b }).pipe(res); }
    else { res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes", "Content-Type": "video/x-matroska" }); createReadStream(mkv).pipe(res); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const svc = new TrackService({ ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", dir: join(dir, "cache"), log: console.error });
  try {
    const id = svc.register(`http://127.0.0.1:${(server.address() as AddressInfo).port}/t.mkv`);
    const t = await svc.probe(id);
    assert.deepEqual(t.audio.map((a) => [a.id, a.lang, a.default]), [[0, "jpn", true], [1, "eng", false]]);
    assert.match(t.audio[1]!.label, /English — English Dub/); assert.match(t.audio[0]!.label, /^Japanese \(AAC/);
    assert.deepEqual(t.subs.map((s) => [s.id, s.lang, s.supported]), [[0, "eng", true], [1, "fre", true]]);
    assert.match(t.subs[0]!.label, /English \(ASS\)/);

    const v0 = readFileSync((await svc.subtitleFile(id, 0))!, "utf8"); const v1 = readFileSync((await svc.subtitleFile(id, 1))!, "utf8");
    assert.match(v0, /^WEBVTT/); assert.match(v0, /Hello from ASS/); assert.match(v1, /Bonjour SRT/); assert.match(v1, /00:0[01]\.\d{3} --> 00:0[23]\.\d{3}/);
    assert.equal(await svc.subtitleFile(id, 9), null);

    assert.equal(svc.audioStatus(id, 1).status, "preparing");
    let st = svc.audioStatus(id, 1); for (let i = 0; i < 100 && st.status === "preparing"; i++) { await new Promise((r) => setTimeout(r, 100)); st = svc.audioStatus(id, 1); }
    assert.equal(st.status, "ready");
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", (st as { path: string }).path]).toString());
    assert.equal(probe.streams.length, 1); assert.equal(probe.streams[0].codec_name, "aac"); assert.equal(probe.streams[0].channels, 2);
    assert.equal(svc.audioStatus(id, 7).status, "missing"); assert.equal(svc.audioStatus("f".repeat(32), 0).status, "missing");
  } finally { server.closeAllConnections(); server.close(); svc.close(); }
});
