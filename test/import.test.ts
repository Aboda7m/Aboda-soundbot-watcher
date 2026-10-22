import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import { ImportError, ImportService } from "../src/import/ImportService.ts";
import { createHttpServer } from "../src/http/server.ts";
import { SoundLibrary } from "../src/sound/SoundLibrary.ts";

const hasFfmpeg = (() => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const opts = { skip: hasFfmpeg ? false : "ffmpeg/ffprobe not installed" };

const work = mkdtempSync(join(tmpdir(), "import-test-"));
const fixtures = join(work, "fixtures");
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "ignore" });
const sine = (secs: number) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`];

before(() => {
  if (!hasFfmpeg) return;
  execFileSync("mkdir", ["-p", fixtures]);
  ff([...sine(1), "-c:a", "pcm_s16le", join(fixtures, "tone.wav")]);
  ff([...sine(1), "-c:a", "libmp3lame", join(fixtures, "tone.mp3")]);
  ff([...sine(1), "-c:a", "libmp3lame", "-metadata", "title=Secret", join(fixtures, "tagged.mp3")]);
  ff([...sine(1), "-c:a", "libvorbis", join(fixtures, "tone.ogg")]);
  ff([...sine(1), "-c:a", "aac", join(fixtures, "tone.m4a")]);
  ff([...sine(1), "-c:a", "flac", join(fixtures, "tone.flac")]);
  ff([...sine(1), "-c:a", "libmp3lame", "-f", "mp3", join(fixtures, "mislabeled.wav")]); // mp3 content, .wav name
  ff([...sine(5), "-c:a", "libmp3lame", join(fixtures, "long.mp3")]);
  ff([...sine(1), "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-shortest", "-c:v", "libx264", "-c:a", "aac", join(fixtures, "video.m4a")]);
  writeFileSync(join(fixtures, "fake.mp3"), "this is not audio at all");
  writeFileSync(join(fixtures, "playlist.mp3"), "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nfile:///etc/passwd\n");
  writeFileSync(join(fixtures, "concat.mp3"), "ffconcat version 1.0\nfile '/etc/passwd'\n");
});
after(() => rmSync(work, { recursive: true, force: true }));

function setup(over: Partial<ConstructorParameters<typeof ImportService>[0]> = {}) {
  const soundsDir = mkdtempSync(join(work, "sounds-"));
  const stagingDir = mkdtempSync(join(work, "staging-"));
  const library = new SoundLibrary(soundsDir, [".mp3", ".wav"]);
  const svc = new ImportService({
    library, soundsDir, stagingDir, acceptedExtensions: [".mp3", ".wav"],
    maxUploadBytes: 1024 * 1024, maxDurationSec: 3, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", ...over,
  });
  return { svc, library, soundsDir, stagingDir };
}
const fixture = (name: string) => Readable.from([readFileSync(join(fixtures, name))]);
const stage = (svc: ImportService, file: string, as = file) => svc.stage(fixture(file), as, null);
const rejects = (p: Promise<unknown>, status: number, msg?: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof ImportError && e.status === status && (!msg || msg.test(e.message)));

test("MP3 and WAV uploads are kept untouched; the real content decides, not the name", opts, async () => {
  const { svc, stagingDir } = setup();
  const a = await stage(svc, "tone.mp3");
  assert.equal(a.result.converted, false);
  assert.equal(a.result.extension, ".mp3");
  assert.equal(readFileSync(svc.preview(a.id)!.path).equals(readFileSync(join(fixtures, "tone.mp3"))), true);
  const b = await stage(svc, "tone.wav");
  assert.equal(b.result.converted, false);
  assert.equal(b.result.extension, ".wav");
  const c = await stage(svc, "mislabeled.wav"); // mp3 data in a .wav name
  assert.equal(c.result.extension, ".mp3");
  assert.equal(c.original.format, "mp3");
  assert.equal(c.suggestedName, "mislabeled");
  assert.ok(Math.abs(a.result.durationSec - 1) < 0.2);
  svc.close();
  assert.deepEqual(readdirSync(stagingDir), []);
});

test("other formats are converted to 48 kHz stereo MP3 with tags removed", opts, async () => {
  const { svc } = setup();
  for (const f of ["tone.ogg", "tone.m4a", "tone.flac"]) {
    const s = await stage(svc, f);
    assert.equal(s.result.converted, true, f);
    assert.equal(s.result.extension, ".mp3", f);
    assert.equal(s.result.sampleRate, 48000, f);
    assert.equal(s.result.channels, 2, f);
    assert.ok(Math.abs(s.result.durationSec - 1) < 0.3, f);
  }
  svc.close();
});

test("converts to WAV when .mp3 is not an accepted extension", opts, async () => {
  const { svc } = setup({ acceptedExtensions: [".wav"] });
  const s = await stage(svc, "tone.ogg");
  assert.equal(s.result.extension, ".wav");
  const k = await stage(svc, "tone.mp3"); // mp3 is not accepted here, so it cannot be kept
  assert.equal(k.result.extension, ".wav");
  assert.equal(k.result.converted, true);
  svc.close();
});

test("rejects bad input with specific messages and leaves no files behind", opts, async () => {
  const { svc, stagingDir } = setup();
  await rejects(stage(svc, "fake.mp3"), 422, /valid audio/);
  await rejects(stage(svc, "playlist.mp3"), 422, /valid audio/); // HLS playlist pointing at a local file
  await rejects(stage(svc, "concat.mp3"), 422, /valid audio/); // ffconcat script
  await rejects(stage(svc, "long.mp3"), 422, /limit is 3 s/);
  await rejects(stage(svc, "video.m4a"), 422, /video/i);
  await rejects(stage(svc, "tone.mp3", "tone.exe"), 415, /Unsupported file type/);
  await rejects(stage(svc, "tone.mp3", "noextension"), 415, /Unsupported file type/);
  await rejects(svc.stage(Readable.from([]), "empty.mp3", null), 400, /empty/);
  assert.deepEqual(readdirSync(stagingDir), []);
  svc.close();
});

test("enforces the upload size limit by declared length and while streaming", opts, async () => {
  const { svc, stagingDir } = setup({ maxUploadBytes: 1000 });
  await rejects(svc.stage(Readable.from([]), "a.mp3", 5000), 413, /too large/);
  await rejects(svc.stage(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), "a.mp3", null), 413, /too large/); // length not declared / lied about
  assert.deepEqual(readdirSync(stagingDir), []);
  svc.close();
});

test("only one file is processed at a time and the pending count is capped", opts, async () => {
  const { svc } = setup({ maxStaged: 2 });
  const first = stage(svc, "tone.ogg");
  const second = stage(svc, "tone.m4a");
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((lost.reason as ImportError).status, 429);
  await stage(svc, "tone.wav");
  await rejects(stage(svc, "tone.mp3"), 429, /Too many pending/);
  svc.close();
});

test("save: valid name lands in the sounds folder and the library sees it immediately", opts, async () => {
  const { svc, library, soundsDir } = setup();
  assert.deepEqual(library.list(), []);
  const s = await stage(svc, "tone.ogg");
  const saved = await svc.save(s.id, "Air Horn");
  assert.deepEqual(saved, { name: "Air Horn", file: "Air Horn.mp3" });
  assert.deepEqual(library.list(), ["Air Horn"]);
  assert.ok(library.resolve("Air Horn")?.endsWith("Air Horn.mp3"));
  assert.deepEqual(readdirSync(soundsDir), ["Air Horn.mp3"]); // no temp files left
  assert.equal(svc.preview(s.id), null); // staged copy is gone
  svc.close();
});

test("save: refuses unsafe names, duplicates (any case) and unknown ids; never overwrites", opts, async () => {
  const { svc, soundsDir } = setup();
  writeFileSync(join(soundsDir, "Taken.mp3"), "ORIGINAL");
  const s = await stage(svc, "tone.wav");
  for (const bad of ["../escape", "a/b", "a\\b", ".hidden", "x.mp3", "", "NUL", 5, null]) await rejects(svc.save(s.id, bad), 400);
  await rejects(svc.save(s.id, "Taken"), 409, /already exists/);
  await rejects(svc.save(s.id, "taken"), 409, /already exists/);
  assert.equal(readFileSync(join(soundsDir, "Taken.mp3"), "utf8"), "ORIGINAL");
  await rejects(svc.save("00000000-0000-0000-0000-000000000000", "ok"), 404);
  await rejects(svc.save("../../etc/passwd", "ok"), 404);
  assert.deepEqual(readdirSync(soundsDir), ["Taken.mp3"]);
  await svc.save(s.id, "fresh"); // the failed attempts did not consume the staged file
  assert.deepEqual(readdirSync(soundsDir).sort(), ["Taken.mp3", "fresh.wav"]);
  svc.close();
});

test("save: a missing sounds folder gives a clear error instead of creating one", opts, async () => {
  const { svc, soundsDir } = setup();
  const s = await stage(svc, "tone.wav");
  rmSync(soundsDir, { recursive: true });
  await rejects(svc.save(s.id, "x"), 500, /sounds folder is missing/);
  assert.equal(existsSync(soundsDir), false);
  svc.close();
});

test("discard and expiry remove staged files", opts, async () => {
  const { svc, stagingDir } = setup({ ttlMs: 1 });
  const a = await stage(svc, "tone.wav");
  assert.equal(svc.discard(a.id), true);
  assert.equal(svc.discard(a.id), false);
  const b = await stage(svc, "tone.wav");
  await new Promise((r) => setTimeout(r, 10));
  await stage(svc, "tone.wav"); // staging sweeps expired entries first
  assert.equal(svc.preview(b.id), null);
  svc.close();
  assert.deepEqual(readdirSync(stagingDir), []);
});

test("startup removes leftovers of a crashed run but nothing else", opts, () => {
  const stagingDir = mkdtempSync(join(work, "staging-"));
  writeFileSync(join(stagingDir, "11111111-1111-1111-1111-111111111111.upload"), "x");
  writeFileSync(join(stagingDir, "keep-me.txt"), "x");
  const svc = new ImportService({ library: new SoundLibrary(work, [".mp3"]), soundsDir: work, stagingDir, acceptedExtensions: [".mp3"], maxUploadBytes: 1, maxDurationSec: 1, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" });
  assert.deepEqual(readdirSync(stagingDir), ["keep-me.txt"]);
  svc.close();
});

test("reports a clear error when ffmpeg is missing", async () => {
  const { svc } = setup({ ffprobePath: "definitely-not-installed-ffprobe" });
  const st = await svc.status();
  assert.equal(st.ready, false);
  assert.match(st.problem ?? "", /ffprobe was not found/);
  await rejects(svc.stage(Readable.from([Buffer.from("x")]), "a.mp3", null), 503);
  svc.close();
});

// ---------------------------------------------------------------------------- HTTP

let server: Server;
let base = "";
let httpSvc: ImportService;
let httpSounds = "";
const KEY = "s3cret";

before(async () => {
  const s = setup();
  httpSvc = s.svc;
  httpSounds = s.soundsDir;
  server = createHttpServer({
    host: "127.0.0.1", port: 0, accessKey: KEY,
    watcher: { payloadJson: () => "{}", addClient: () => {} } as never,
    library: s.library,
    repo: { sounds: () => [] } as never,
    queue: { enqueue: () => ({ ok: true, position: 1 }), status: () => [] } as never,
    canTarget: () => true,
    importer: s.svc,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => { server.close(); httpSvc.close(); });

const upload = (file: string, headers: Record<string, string> = {}, name = file) =>
  fetch(`${base}/api/import/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(name), "X-Access-Key": KEY, ...headers },
    body: readFileSync(join(fixtures, file)),
  });
const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Access-Key": KEY, ...headers }, body: JSON.stringify(body) });

test("http: page and assets are served with a media-src CSP; the dashboard's CSP is unchanged", async () => {
  const page = await fetch(`${base}/import`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.headers.get("content-security-policy") ?? "", /media-src 'self'/);
  assert.equal((await fetch(`${base}/import.js`)).status, 200);
  assert.equal((await fetch(`${base}/import.css`)).status, 200);
  const dash = await fetch(`${base}/`);
  assert.equal(dash.status, 200);
  assert.doesNotMatch(dash.headers.get("content-security-policy") ?? "", /media-src/);
});

test("http: import API requires the access key and refuses cross-origin or wrong content types", opts, async () => {
  assert.equal((await fetch(`${base}/api/import/config`)).status, 401);
  assert.equal((await fetch(`${base}/api/import/config?key=${KEY}`)).status, 200);
  assert.equal((await upload("tone.wav", { "X-Access-Key": "wrong" })).status, 401);
  assert.equal((await upload("tone.wav", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await upload("tone.wav", { "Content-Type": "application/json" })).status, 415);
  assert.equal((await upload("tone.wav", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await postJson("/api/import/save", { id: "x", name: "y" }, { "X-Access-Key": "wrong" })).status, 401);
  assert.equal((await fetch(`${base}/api/import/preview/11111111-1111-1111-1111-111111111111`)).status, 401);
});

test("http: upload -> preview (with Range) -> save -> library lists it, no restart", opts, async () => {
  const up = await upload("tone.ogg", {}, "Boom Boom.ogg");
  assert.equal(up.status, 201);
  const info = await up.json() as { id: string; suggestedName: string; result: { converted: boolean; extension: string } };
  assert.equal(info.suggestedName, "Boom Boom");
  assert.equal(info.result.converted, true);

  const prev = await fetch(`${base}/api/import/preview/${info.id}?key=${KEY}`);
  assert.equal(prev.status, 200);
  assert.equal(prev.headers.get("content-type"), "audio/mpeg");
  const full = Buffer.from(await prev.arrayBuffer());
  assert.equal(Number(prev.headers.get("content-length")), full.length);
  const part = await fetch(`${base}/api/import/preview/${info.id}?key=${KEY}`, { headers: { Range: "bytes=10-19" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 10-19/${full.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).equals(full.subarray(10, 20)), true);
  assert.equal((await fetch(`${base}/api/import/preview/${info.id}?key=${KEY}`, { headers: { Range: "bytes=999999-" } })).status, 416);

  const bad = await postJson("/api/import/save", { id: info.id, name: "../evil" });
  assert.equal(bad.status, 400);
  const ok = await postJson("/api/import/save", { id: info.id, name: info.suggestedName });
  assert.equal(ok.status, 201);
  assert.deepEqual(readdirSync(httpSounds), ["Boom Boom.mp3"]);
  const sounds = await (await fetch(`${base}/api/sounds?key=${KEY}`)).json() as { sounds: { name: string }[] };
  assert.deepEqual(sounds.sounds.map((s) => s.name), ["Boom Boom"]);
  assert.equal((await fetch(`${base}/api/import/preview/${info.id}?key=${KEY}`)).status, 404);
});

test("http: validation errors come back as JSON with a useful message", opts, async () => {
  const fake = await upload("fake.mp3");
  assert.equal(fake.status, 422);
  assert.match(((await fake.json()) as { error: string }).error, /valid audio/);
  assert.equal((await upload("tone.wav", {}, "x.exe")).status, 415);
  assert.equal((await upload("tone.wav", { "X-Filename": "" })).status, 400);
  const bigBody = Buffer.alloc(2 * 1024 * 1024);
  const big = await fetch(`${base}/api/import/upload`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Filename": "big.mp3", "X-Access-Key": KEY }, body: bigBody }).catch((e: Error) => e);
  // Either the 413 reaches the client or the server closes the connection first; both are a refusal, and nothing is kept.
  if (big instanceof Response) assert.equal(big.status, 413);
  assert.equal(readdirSync(httpSounds).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("http: discard removes a staged import", opts, async () => {
  const info = await (await upload("tone.wav")).json() as { id: string };
  assert.equal((await postJson("/api/import/discard", { id: info.id })).status, 200);
  assert.equal((await fetch(`${base}/api/import/preview/${info.id}?key=${KEY}`)).status, 404);
  assert.equal((await postJson("/api/import/discard", {})).status, 400);
});

test("http: without an importer the import page and API do not exist", async () => {
  const s = createHttpServer({
    host: "127.0.0.1", port: 0, accessKey: "",
    watcher: { payloadJson: () => "{}", addClient: () => {} } as never,
    library: { has: () => false, list: () => [] } as never,
    repo: { sounds: () => [] } as never,
    queue: { enqueue: () => ({ ok: true, position: 1 }), status: () => [] } as never,
    canTarget: () => true,
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const b = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  assert.equal((await fetch(`${b}/import`)).status, 404);
  assert.equal((await fetch(`${b}/api/import/config`)).status, 404);
  assert.equal((await fetch(`${b}/api/import/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404);
  s.close();
});
