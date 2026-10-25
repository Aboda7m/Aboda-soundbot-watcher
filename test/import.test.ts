import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ImportError, ImportService } from "../src/import/ImportService.ts";
import { startPublic, type PublicHarness } from "./helpers/harness.ts";
import { SoundLibrary } from "../src/sound/SoundLibrary.ts";

const hasFfmpeg = (() => {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const opts = { skip: hasFfmpeg ? false : "ffmpeg/ffprobe not installed" };
const wrapperOpts = { skip: !hasFfmpeg ? "ffmpeg/ffprobe not installed" : process.platform === "win32" ? "shell wrappers need a POSIX shell" : false };

const work = mkdtempSync(join(tmpdir(), "import-test-"));
const fixtures = join(work, "fixtures");
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "ignore" });
const sine = (secs: number) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`];
const video = (secs: number) => ["-f", "lavfi", "-i", `color=c=red:s=64x64:r=5:d=${secs}`];
const streamTypes = (path: string): string[] =>
  (JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", path]).toString()).streams as { codec_type: string }[]).map((s) => s.codec_type);
const near = (a: number, b: number, tol = 0.3) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

before(() => {
  if (!hasFfmpeg) return;
  mkdirSync(fixtures, { recursive: true });
  ff([...sine(1), "-c:a", "pcm_s16le", join(fixtures, "tone.wav")]);
  ff([...sine(1), "-c:a", "libmp3lame", join(fixtures, "tone.mp3")]);
  ff([...sine(1), "-c:a", "libmp3lame", "-metadata", "title=Secret", join(fixtures, "tagged.mp3")]);
  ff([...sine(1), "-c:a", "libvorbis", join(fixtures, "tone.ogg")]);
  ff([...sine(1), "-c:a", "libopus", join(fixtures, "tone.opus")]);
  ff([...sine(1), "-c:a", "aac", join(fixtures, "tone.m4a")]);
  ff([...sine(1), "-c:a", "flac", join(fixtures, "tone.flac")]);
  ff([...sine(1), "-c:a", "libopus", "-f", "webm", join(fixtures, "tone.webm")]); // audio-only WebM
  ff([...sine(1), "-c:a", "libmp3lame", "-f", "mp3", join(fixtures, "mislabeled.wav")]); // mp3 content, .wav name
  // long audio: 40 s is over the old 30 s limit
  ff([...sine(40), "-c:a", "libmp3lame", join(fixtures, "long.mp3")]);
  ff([...sine(40), "-c:a", "pcm_s16le", "-ar", "8000", "-ac", "1", join(fixtures, "long.wav")]);
  // video with audio, 15 s, four containers
  const av = (name: string, vc: string[], ac: string[]) =>
    ff([...video(15), ...sine(15), "-shortest", ...vc, ...ac, join(fixtures, name)]);
  av("clip.mp4", ["-c:v", "libx264", "-preset", "ultrafast"], ["-c:a", "aac"]);
  av("clip.mov", ["-c:v", "libx264", "-preset", "ultrafast"], ["-c:a", "aac"]);
  av("clip.mkv", ["-c:v", "libx264", "-preset", "ultrafast"], ["-c:a", "libvorbis"]);
  av("clip.webm", ["-c:v", "libvpx", "-b:v", "50k"], ["-c:a", "libvorbis"]);
  // video without any audio track
  ff([...video(3), "-c:v", "libx264", "-preset", "ultrafast", "-an", join(fixtures, "silent-video.mp4")]);
  ff([...video(3), "-c:v", "libvpx", "-b:v", "50k", "-an", join(fixtures, "silent-video.webm")]);
  // WebM written to a pipe has no duration in its header
  const fd = openSync(join(fixtures, "unknown-duration.webm"), "w");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...sine(4), "-c:a", "libopus", "-f", "webm", "-"], { stdio: ["ignore", fd, "ignore"] });
  closeSync(fd);
  // broken / hostile files
  writeFileSync(join(fixtures, "fake.mp3"), "this is not audio at all");
  writeFileSync(join(fixtures, "truncated.mp4"), readFileSync(join(fixtures, "clip.mp4")).subarray(0, 600));
  writeFileSync(join(fixtures, "garbage.mkv"), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)));
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
    maxUploadBytes: 5 * 1024 * 1024, maxOutputSec: 120, defaultTrimSec: 10, maxOutputBytes: 50 * 1024 * 1024,
    processTimeoutMs: 60_000, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", ...over,
  });
  return { svc, library, soundsDir, stagingDir };
}
const fixture = (name: string) => Readable.from([readFileSync(join(fixtures, name))]);
const stage = (svc: ImportService, file: string, as = file) => svc.stage(fixture(file), as, null);
const rejects = (p: Promise<unknown>, status: number, msg?: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof ImportError && e.status === status && (!msg || msg.test(e.message)));

/** A fake ffmpeg that behaves like the real one for capability checks but runs `body` for real jobs. */
function wrapper(name: string, body: string): string {
  const path = join(work, name);
  writeFileSync(path, `#!/bin/sh\ncase "$1" in -version|-hide_banner) ${body.includes("#CAPS") ? body.split("#CAPS")[1]!.split("\n")[0] : 'exec ffmpeg "$@"'} ;; esac\n${body.split("#CAPS")[0]}\n`);
  chmodSync(path, 0o755);
  return path;
}

// ------------------------------------------------------------------------------------ formats

test("short MP3 and WAV uploads are kept untouched; the real content decides, not the name", opts, async () => {
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
  near(a.result.durationSec, 1, 0.2);
  svc.close();
  assert.deepEqual(readdirSync(stagingDir), []);
});

test("other audio formats are converted to 48 kHz stereo MP3 with tags removed", opts, async () => {
  const { svc } = setup({ maxStaged: 10 });
  for (const f of ["tone.ogg", "tone.opus", "tone.m4a", "tone.flac", "tone.webm"]) {
    const s = await stage(svc, f);
    assert.equal(s.result.converted, true, f);
    assert.equal(s.result.extension, ".mp3", f);
    assert.equal(s.result.sampleRate, 48000, f);
    assert.equal(s.result.channels, 2, f);
    assert.equal(s.original.hasVideo, false, f);
    near(s.result.durationSec, 1, 0.3);
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

for (const f of ["clip.mp4", "clip.mov", "clip.mkv", "clip.webm"]) {
  test(`video upload ${f}: audio is extracted, the video is discarded, default trim applies`, opts, async () => {
    const { svc } = setup();
    const s = await stage(svc, f);
    assert.equal(s.original.hasVideo, true);
    near(s.original.durationSec!, 15, 0.5);
    assert.equal(s.result.mode, "first");
    near(s.result.durationSec, 10, 0.3);
    assert.equal(s.result.extension, ".mp3");
    assert.equal(s.result.converted, true);
    assert.deepEqual(streamTypes(svc.preview(s.id)!.path), ["audio"]);
    svc.close();
  });
}

test("content decides, not the file name: a video named .mp3 works, MP3 data named .mp4 is kept as MP3", opts, async () => {
  const { svc } = setup();
  const v = await stage(svc, "clip.mp4", "renamed.mp3");
  assert.equal(v.original.hasVideo, true);
  assert.equal(v.result.converted, true);
  const m = await stage(svc, "tone.mp3", "really-mp3.mp4");
  assert.equal(m.original.format, "mp3");
  assert.equal(m.result.converted, false);
  svc.close();
});

test("a video without an audio track is rejected with a clear message", opts, async () => {
  const { svc, stagingDir } = setup();
  await rejects(stage(svc, "silent-video.mp4"), 422, /no audio track/);
  await rejects(stage(svc, "silent-video.webm"), 422, /no audio track/);
  assert.deepEqual(readdirSync(stagingDir), []);
  svc.close();
});

test("unsupported, corrupt and hostile files are rejected and leave nothing behind", opts, async () => {
  const { svc, stagingDir } = setup();
  await rejects(stage(svc, "fake.mp3"), 422, /valid audio or video/);
  await rejects(stage(svc, "truncated.mp4"), 422, /valid audio or video/);
  await rejects(stage(svc, "garbage.mkv"), 422, /valid audio or video/);
  await rejects(stage(svc, "playlist.mp3"), 422, /valid audio or video/); // HLS playlist pointing at a local file
  await rejects(stage(svc, "concat.mp3"), 422, /valid audio or video/); // ffconcat script
  await rejects(stage(svc, "tone.mp3", "tone.exe"), 415, /Unsupported file type/);
  await rejects(stage(svc, "tone.mp3", "tone.gif"), 415, /Unsupported file type/);
  await rejects(stage(svc, "tone.mp3", "noextension"), 415, /Unsupported file type/);
  await rejects(svc.stage(Readable.from([]), "empty.mp3", null), 400, /empty/);
  assert.deepEqual(readdirSync(stagingDir), []);
  svc.close();
});

// ------------------------------------------------------------------------------------ trimming

test("long audio is accepted (no 30 s limit) and trimmed to the first 10 s by default", opts, async () => {
  const { svc } = setup();
  const s = await stage(svc, "long.mp3");
  near(s.original.durationSec!, 40, 0.5);
  assert.equal(s.result.mode, "first");
  assert.equal(s.result.startSec, 0);
  near(s.result.durationSec, 10, 0.3);
  assert.equal(s.result.converted, true); // trimming needs a re-encode
  assert.equal(s.result.version, 1);
  const w = await stage(svc, "long.wav"); // also WAV
  near(w.result.durationSec, 10, 0.3);
  svc.close();
});

test("the default length is configurable", opts, async () => {
  const { svc } = setup({ defaultTrimSec: 3 });
  near((await stage(svc, "long.mp3")).result.durationSec, 3, 0.3);
  svc.close();
});

test("custom range by start+end and by start+length; each render replaces the previous preview", opts, async () => {
  const { svc } = setup();
  const s = await stage(svc, "long.mp3");
  const first = svc.preview(s.id)!.path;
  const r1 = await svc.process(s.id, { mode: "range", start: 12, end: 15.5 });
  near(r1.durationSec, 3.5, 0.3);
  assert.equal(r1.mode, "range");
  assert.equal(r1.version, 2);
  near(r1.startSec, 12, 0.01);
  assert.notEqual(svc.preview(s.id)!.path, first);
  assert.equal(existsSync(first), false); // old render removed
  const r2 = await svc.process(s.id, { mode: "range", start: 30, duration: 2 });
  near(r2.durationSec, 2, 0.3);
  const r3 = await svc.process(s.id, { mode: "first" }); // back to the default
  near(r3.durationSec, 10, 0.3);
  assert.equal(r3.version, 4);
  svc.close();
});

test("a range really selects that part of the audio (a tone that changes at 20 s)", opts, async () => {
  const { svc } = setup();
  const src = join(work, "two-tones.mp3");
  ff(["-f", "lavfi", "-i", "sine=frequency=300:duration=20", "-f", "lavfi", "-i", "sine=frequency=3000:duration=20", "-filter_complex", "[0][1]concat=n=2:v=0:a=1", "-c:a", "libmp3lame", src]);
  const s = await svc.stage(Readable.from([readFileSync(src)]), "two-tones.mp3", null);
  const loud = (path: string) => { // dominant tone via zero-crossing count of the decoded samples
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { maxBuffer: 1e8 });
    let crossings = 0;
    for (let i = 2; i < raw.length; i += 2) if ((raw.readInt16LE(i) >= 0) !== (raw.readInt16LE(i - 2) >= 0)) crossings++;
    return crossings / (raw.length / 2 / 16000) / 2; // Hz
  };
  assert.ok(Math.abs(loud(svc.preview(s.id)!.path) - 300) < 40); // default: first 10 s are the low tone
  await svc.process(s.id, { mode: "range", start: 25, end: 30 });
  assert.ok(Math.abs(loud(svc.preview(s.id)!.path) - 3000) < 200); // 25-30 s are the high tone
  svc.close();
});

test("full audio is explicit: MP3/WAV kept byte-for-byte, other formats converted whole", opts, async () => {
  const { svc } = setup();
  const s = await stage(svc, "long.mp3");
  const full = await svc.process(s.id, { mode: "full" });
  assert.equal(full.mode, "full");
  assert.equal(full.converted, false);
  near(full.durationSec, 40, 0.5);
  assert.equal(readFileSync(svc.preview(s.id)!.path).equals(readFileSync(join(fixtures, "long.mp3"))), true);
  const v = await stage(svc, "clip.mkv");
  const fullVideo = await svc.process(v.id, { mode: "full" });
  assert.equal(fullVideo.converted, true);
  near(fullVideo.durationSec, 15, 0.5);
  assert.deepEqual(streamTypes(svc.preview(v.id)!.path), ["audio"]);
  svc.close();
});

test("fractional lengths work: full audio of a 22.667 s video, and odd range lengths (regression: non-integer FFmpeg timeout)", opts, async () => {
  const { svc } = setup();
  const src = join(work, "odd-length.mp4");
  ff([...video(22.667), ...sine(22.667), "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
  const s = await svc.stage(Readable.from([readFileSync(src)]), "odd-length.mp4", null);
  near(s.original.durationSec!, 22.7, 0.3);
  const full = await svc.process(s.id, { mode: "full" });
  assert.equal(full.mode, "full");
  near(full.durationSec, s.original.durationSec!, 0.3);
  for (const range of [{ start: 1.2345, duration: 3.3333 }, { start: 0.1, end: 7.777 }, { start: 5.5, end: 22.6 }])
    assert.ok((await svc.process(s.id, { mode: "range", ...range })).durationSec > 3);
  svc.close();
});

test("full audio and long selections are capped by IMPORT_MAX_OUTPUT_SEC", opts, async () => {
  const { svc } = setup({ maxOutputSec: 20 });
  const s = await stage(svc, "long.mp3");
  await rejects(svc.process(s.id, { mode: "full" }), 400, /Full audio is 40 s long.*limit.*20/);
  await rejects(svc.process(s.id, { mode: "range", start: 0, end: 30 }), 400, /limit for a saved sound is 20/);
  near((await svc.process(s.id, { mode: "range", start: 0, end: 20 })).durationSec, 20, 0.3);
  svc.close();
});

test("invalid ranges are rejected against the real duration and the previous preview survives", opts, async () => {
  const { svc } = setup();
  const s = await stage(svc, "long.mp3");
  const before = svc.preview(s.id)!.path;
  await rejects(svc.process(s.id, { mode: "range", start: 50, end: 60 }), 400, /at or past the end of the audio \(40 s\)/);
  await rejects(svc.process(s.id, { mode: "range", start: 10, end: 90 }), 400, /after the end of the audio/);
  await rejects(svc.process(s.id, { mode: "range", start: 10, end: 10 }), 400, /End time must be after/);
  await rejects(svc.process(s.id, { mode: "range", start: 10, end: 5 }), 400, /End time must be after/);
  await rejects(svc.process(s.id, { mode: "range", start: -3, end: 5 }), 400, /negative/);
  await rejects(svc.process(s.id, { mode: "range", start: "x", end: 5 }), 400, /number/);
  await rejects(svc.process(s.id, { mode: "range", start: 1 }), 400, /end time or a length/);
  await rejects(svc.process(s.id, { mode: "nope" }), 400, /Trim mode/);
  await rejects(svc.process("not-an-id", { mode: "first" }), 404);
  assert.equal(svc.preview(s.id)!.path, before);
  assert.equal(existsSync(before), true);
  svc.close();
});

test("a file that does not state its duration still works; empty ranges are caught after rendering", opts, async (t) => {
  const { svc } = setup();
  const s = await stage(svc, "unknown-duration.webm");
  if (s.original.durationSec !== null) return t.skip("this ffprobe estimates the duration of the fixture");
  near(s.result.durationSec, 4, 0.5); // default selection is longer than the file, the real length is measured
  near((await svc.process(s.id, { mode: "range", start: 1, end: 2 })).durationSec, 1, 0.3);
  near((await svc.process(s.id, { mode: "full" })).durationSec, 4, 0.5);
  await rejects(svc.process(s.id, { mode: "range", start: 100, end: 105 }), 422);
  assert.equal(existsSync(svc.preview(s.id)!.path), true);
  svc.close();
});

// ------------------------------------------------------------------------------------ limits & failures

test("enforces the upload size limit by declared length and while streaming", opts, async () => {
  const { svc, stagingDir } = setup({ maxUploadBytes: 1000 });
  await rejects(svc.stage(Readable.from([]), "a.mp3", 5000), 413, /too large/);
  await rejects(svc.stage(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), "a.mp3", null), 413, /too large/);
  assert.deepEqual(readdirSync(stagingDir), []);
  svc.close();
});

test("refuses uploads when the disk is nearly full", opts, async () => {
  const { svc, stagingDir } = setup({ freeSpace: async () => 1024 });
  await rejects(stage(svc, "tone.mp3"), 507, /disk space/);
  assert.deepEqual(readdirSync(stagingDir), []);
  svc.close();
  const ok = setup({ freeSpace: async () => null }); // unknown free space must not block imports
  await stage(ok.svc, "tone.mp3");
  ok.svc.close();
});

test("only one file is processed at a time and the pending count is capped", opts, async () => {
  const { svc } = setup({ maxStaged: 2 });
  const results = await Promise.allSettled([stage(svc, "tone.ogg"), stage(svc, "tone.m4a")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((lost.reason as ImportError).status, 429);
  await stage(svc, "tone.wav");
  await rejects(stage(svc, "tone.mp3"), 429, /Too many pending/);
  svc.close();
});

test("processing failure at upload time: clear error, nothing left in staging", wrapperOpts, async () => {
  const ffmpegPath = wrapper("ffmpeg-fails", 'echo "boom" >&2; exit 1');
  const { svc, stagingDir } = setup({ ffmpegPath });
  await rejects(stage(svc, "tone.ogg"), 422, /FFmpeg could not process/);
  await rejects(stage(svc, "clip.mp4"), 422, /FFmpeg could not process/);
  assert.deepEqual(readdirSync(stagingDir), []); // no .src, no .part
  svc.close();
});

test("processing failure on re-trim keeps the previous preview and the source; retrying works", wrapperOpts, async () => {
  const flag = join(work, "fail-now");
  rmSync(flag, { force: true });
  const ffmpegPath = wrapper("ffmpeg-flaky", `if [ -e "${flag}" ]; then echo boom >&2; exit 1; fi\nexec ffmpeg "$@"`);
  const { svc, stagingDir } = setup({ ffmpegPath });
  const s = await stage(svc, "long.mp3");
  const before = svc.preview(s.id)!.path;
  writeFileSync(flag, "");
  await rejects(svc.process(s.id, { mode: "range", start: 5, end: 8 }), 422, /FFmpeg could not process/);
  assert.equal(svc.preview(s.id)!.path, before);
  assert.equal(readdirSync(stagingDir).some((f) => f.endsWith(".part")), false);
  rmSync(flag);
  near((await svc.process(s.id, { mode: "range", start: 5, end: 8 })).durationSec, 3, 0.3);
  svc.close();
});

test("a stuck FFmpeg is killed after the timeout and cleaned up", wrapperOpts, async () => {
  const ffmpegPath = wrapper("ffmpeg-hangs", "exec sleep 20");
  const { svc, stagingDir } = setup({ ffmpegPath, processTimeoutMs: 700 });
  await rejects(stage(svc, "tone.ogg"), 422, /took too long/);
  assert.deepEqual(readdirSync(stagingDir), []);
  svc.close();
});

test("an output that would be too large is refused before FFmpeg runs", opts, async () => {
  const { svc } = setup({ maxOutputBytes: 100_000 }); // 10 s of MP3 estimates at 400 KB
  await rejects(stage(svc, "long.mp3"), 422, /too large as MP3/);
  svc.close();
});

test("capability check: formats this FFmpeg cannot read are not offered", wrapperOpts, async () => {
  const ffmpegPath = wrapper("ffmpeg-no-mkv", `exec ffmpeg "$@"\n#CAPS if [ "$2" = "-demuxers" ]; then ffmpeg "$@" | grep -v matroska; exit 0; fi; exec ffmpeg "$@"`);
  const { svc } = setup({ ffmpegPath });
  assert.equal((await svc.status()).ready, true);
  const ext = svc.limits().extensions;
  assert.equal(ext.includes(".mkv"), false);
  assert.equal(ext.includes(".webm"), false);
  assert.equal(ext.includes(".mp4"), true);
  await rejects(stage(svc, "clip.mkv"), 415, /Unsupported file type/);
  near((await stage(svc, "clip.mp4")).result.durationSec, 10, 0.3);
  svc.close();
});

test("capability check: no MP3 encoder falls back to WAV, or reports a clear problem", wrapperOpts, async () => {
  const caps = `#CAPS if [ "$2" = "-encoders" ]; then ffmpeg "$@" | grep -v libmp3lame; exit 0; fi; exec ffmpeg "$@"`;
  const ffmpegPath = wrapper("ffmpeg-no-lame", `exec ffmpeg "$@"\n${caps}`);
  const both = setup({ ffmpegPath });
  assert.equal(both.svc.limits().outputExtension, ".mp3"); // optimistic until FFmpeg has been asked
  assert.equal((await both.svc.status()).ready, true);
  assert.equal(both.svc.limits().outputExtension, ".wav");
  assert.equal((await stage(both.svc, "tone.ogg")).result.extension, ".wav");
  both.svc.close();
  const mp3Only = setup({ ffmpegPath, acceptedExtensions: [".mp3"] });
  const st = await mp3Only.svc.status();
  assert.equal(st.ready, false);
  assert.match(st.problem ?? "", /no MP3 encoder/);
  mp3Only.svc.close();
});

// ------------------------------------------------------------------------------------ saving

test("save: the current render lands in the sounds folder, the library sees it immediately, the source is removed", opts, async () => {
  const { svc, library, soundsDir, stagingDir } = setup();
  assert.deepEqual(library.list(), []);
  const s = await stage(svc, "long.mp3");
  await svc.process(s.id, { mode: "range", start: 5, end: 7 });
  const saved = await svc.save(s.id, "Air Horn");
  assert.deepEqual(saved, { name: "Air Horn", file: "Air Horn.mp3" });
  assert.deepEqual(library.list(), ["Air Horn"]);
  near(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", library.resolve("Air Horn")!]).toString()).format.duration, 2, 0.3);
  assert.deepEqual(readdirSync(soundsDir), ["Air Horn.mp3"]); // no temp files left
  assert.equal(svc.preview(s.id), null);
  assert.deepEqual(readdirSync(stagingDir), []); // source and render are gone
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

test("discard and expiry remove the source and the render", opts, async () => {
  const { svc, stagingDir } = setup({ ttlMs: 1 });
  const a = await stage(svc, "long.mp3");
  assert.equal(svc.discard(a.id), true);
  assert.equal(svc.discard(a.id), false);
  assert.deepEqual(readdirSync(stagingDir), []);
  const b = await stage(svc, "long.mp3");
  await new Promise((r) => setTimeout(r, 10));
  await stage(svc, "tone.wav"); // staging sweeps expired entries first
  assert.equal(svc.preview(b.id), null);
  svc.close();
  assert.deepEqual(readdirSync(stagingDir), []);
});

test("startup removes leftovers of a crashed run but nothing else", opts, () => {
  const stagingDir = mkdtempSync(join(work, "staging-"));
  const id = "11111111-1111-1111-1111-111111111111";
  for (const f of [`${id}.src`, `${id}.part`, `${id}.out3.mp3`, "keep-me.txt"]) writeFileSync(join(stagingDir, f), "x");
  const svc = new ImportService({
    library: new SoundLibrary(work, [".mp3"]), soundsDir: work, stagingDir, acceptedExtensions: [".mp3"],
    maxUploadBytes: 1, maxOutputSec: 1, defaultTrimSec: 1, maxOutputBytes: 1, processTimeoutMs: 1, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe",
  });
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

// ---------------------------------------------------------------------------------------- HTTP

let pubH: PublicHarness;
let base = "";
let cookie = ""; // signed-in dashboard session (Discord OAuth is faked; see helpers/harness.ts)
let httpSvc: ImportService;
let httpSounds = "";
const authFetch = (url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string> | undefined) } });

before(async () => {
  const s = setup({ maxStaged: 10 });
  httpSvc = s.svc;
  httpSounds = s.soundsDir;
  pubH = await startPublic({
    library: s.library,
    repo: { sounds: () => [] } as never,
    canTarget: () => true,
    importer: s.svc,
  });
  base = pubH.base;
  cookie = await pubH.signIn();
});
after(() => { pubH.close(); httpSvc.close(); });

const upload = (file: string, headers: Record<string, string> = {}, name = file) =>
  fetch(`${base}/api/import/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(name), Cookie: cookie, Origin: base, ...headers },
    body: readFileSync(join(fixtures, file)),
  });
const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: base, ...headers }, body: JSON.stringify(body) });

test("http: page and assets are served with a media-src CSP; the dashboard's CSP is unchanged", async () => {
  const page = await authFetch(`${base}/import`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.headers.get("content-security-policy") ?? "", /media-src 'self'/);
  assert.equal((await authFetch(`${base}/import.js`)).status, 200);
  assert.equal((await authFetch(`${base}/import.css`)).status, 200);
  const dash = await authFetch(`${base}/`);
  assert.equal(dash.status, 200);
  assert.doesNotMatch(dash.headers.get("content-security-policy") ?? "", /media-src/);
});

test("http: config reports limits, default trim and supported formats", opts, async () => {
  const cfg = await (await authFetch(`${base}/api/import/config`)).json() as Record<string, unknown>;
  assert.equal(cfg.ready, true);
  assert.equal(cfg.defaultTrimSec, 10);
  assert.equal(cfg.maxOutputSec, 120);
  assert.ok((cfg.extensions as string[]).includes(".mp4") && (cfg.extensions as string[]).includes(".mkv"));
  assert.equal(cfg.maxDurationSec, undefined); // the old fixed duration limit is gone
});

test("http: import API requires a dashboard session and refuses cross-origin or wrong content types", opts, async () => {
  assert.equal((await fetch(`${base}/api/import/config`)).status, 401);
  assert.equal((await upload("tone.wav", { Cookie: "aboda_sid=wrong" })).status, 401);
  assert.equal((await upload("tone.wav", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await upload("tone.wav", { "Content-Type": "application/json" })).status, 415);
  assert.equal((await upload("tone.wav", { "Content-Type": "text/plain" })).status, 415);
  const id = "11111111-1111-1111-1111-111111111111";
  assert.equal((await postJson("/api/import/save", { id, name: "y" }, { Cookie: "aboda_sid=wrong" })).status, 401);
  assert.equal((await postJson("/api/import/process", { id, mode: "first" }, { Cookie: "aboda_sid=wrong" })).status, 401);
  assert.equal((await postJson("/api/import/process", { id, mode: "first" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(`${base}/api/import/process`, { method: "POST", headers: { "Content-Type": "text/plain", Cookie: cookie, Origin: base }, body: "{}" })).status, 415);
  assert.equal((await fetch(`${base}/api/import/preview/${id}`)).status, 401);
});

test("http: upload (default 10 s) -> re-trim -> preview with Range -> save -> library lists it, no restart", opts, async () => {
  const up = await upload("long.mp3", {}, "Boom Boom.mp3");
  assert.equal(up.status, 201);
  const info = await up.json() as { id: string; suggestedName: string; original: { durationSec: number }; result: { mode: string; durationSec: number; version: number } };
  assert.equal(info.suggestedName, "Boom Boom");
  near(info.original.durationSec, 40, 0.5);
  assert.equal(info.result.mode, "first");
  near(info.result.durationSec, 10, 0.3);

  const defaultPreview = Buffer.from(await (await authFetch(`${base}/api/import/preview/${info.id}`)).arrayBuffer());

  const proc = await postJson("/api/import/process", { id: info.id, mode: "range", start: 12, end: 14 });
  assert.equal(proc.status, 200);
  const pr = await proc.json() as { ok: boolean; result: { mode: string; durationSec: number; version: number; startSec: number } };
  assert.equal(pr.result.mode, "range");
  assert.equal(pr.result.version, 2);
  near(pr.result.durationSec, 2, 0.3);

  const prev = await authFetch(`${base}/api/import/preview/${info.id}?v=2`);
  assert.equal(prev.status, 200);
  assert.equal(prev.headers.get("content-type"), "audio/mpeg");
  const full = Buffer.from(await prev.arrayBuffer());
  assert.notEqual(full.length, defaultPreview.length); // the preview is the new render
  assert.equal(Number(prev.headers.get("content-length")), full.length);
  const part = await authFetch(`${base}/api/import/preview/${info.id}`, { headers: { Range: "bytes=10-19" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 10-19/${full.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).equals(full.subarray(10, 20)), true);
  assert.equal((await authFetch(`${base}/api/import/preview/${info.id}`, { headers: { Range: "bytes=999999999-" } })).status, 416);

  const badRange = await postJson("/api/import/process", { id: info.id, mode: "range", start: 100, end: 110 });
  assert.equal(badRange.status, 400);
  assert.match(((await badRange.json()) as { error: string }).error, /past the end/);

  assert.equal((await postJson("/api/import/save", { id: info.id, name: "../evil" })).status, 400);
  const ok = await postJson("/api/import/save", { id: info.id, name: info.suggestedName });
  assert.equal(ok.status, 201);
  assert.deepEqual(readdirSync(httpSounds), ["Boom Boom.mp3"]);
  assert.equal(statSync(join(httpSounds, "Boom Boom.mp3")).size, full.length); // what was saved is what was previewed
  const sounds = await (await authFetch(`${base}/api/sounds`)).json() as { sounds: { name: string }[] };
  assert.deepEqual(sounds.sounds.map((s) => s.name), ["Boom Boom"]);
  assert.equal((await authFetch(`${base}/api/import/preview/${info.id}`)).status, 404);
  assert.equal((await postJson("/api/import/process", { id: info.id, mode: "first" })).status, 404);
});

test("http: a duplicate name is refused with a 409 and nothing is overwritten", opts, async () => {
  const info = await (await upload("tone.wav", {}, "Boom Boom.wav")).json() as { id: string; nameTaken: boolean };
  assert.equal(info.nameTaken, true);
  const dup = await postJson("/api/import/save", { id: info.id, name: "boom boom" });
  assert.equal(dup.status, 409);
  assert.deepEqual(readdirSync(httpSounds), ["Boom Boom.mp3"]);
  assert.equal((await postJson("/api/import/discard", { id: info.id })).status, 200);
});

test("http: MP4 upload returns the original and output durations; no-audio video gets a 422", opts, async () => {
  const up = await upload("clip.mp4");
  assert.equal(up.status, 201);
  const info = await up.json() as { id: string; original: { hasVideo: boolean; durationSec: number }; result: { durationSec: number; extension: string } };
  assert.equal(info.original.hasVideo, true);
  near(info.original.durationSec, 15, 0.5);
  near(info.result.durationSec, 10, 0.3);
  const full = await postJson("/api/import/process", { id: info.id, mode: "full" });
  near(((await full.json()) as { result: { durationSec: number } }).result.durationSec, 15, 0.5);
  await postJson("/api/import/discard", { id: info.id });
  const silent = await upload("silent-video.mp4");
  assert.equal(silent.status, 422);
  assert.match(((await silent.json()) as { error: string }).error, /no audio track/);
});

test("http: validation errors come back as JSON with a useful message", opts, async () => {
  const fake = await upload("fake.mp3");
  assert.equal(fake.status, 422);
  assert.match(((await fake.json()) as { error: string }).error, /valid audio or video/);
  assert.equal((await upload("tone.wav", {}, "x.exe")).status, 415);
  assert.equal((await upload("tone.wav", { "X-Filename": "" })).status, 400);
  const bigBody = Buffer.alloc(6 * 1024 * 1024);
  const big = await fetch(`${base}/api/import/upload`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Filename": "big.mp3", Cookie: cookie, Origin: base }, body: bigBody }).catch((e: Error) => e);
  if (big instanceof Response) assert.equal(big.status, 413); // or the server closed the connection first; both are a refusal
  assert.equal(readdirSync(httpSounds).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("http: discard removes a staged import", opts, async () => {
  const info = await (await upload("tone.wav")).json() as { id: string };
  assert.equal((await postJson("/api/import/discard", { id: info.id })).status, 200);
  assert.equal((await authFetch(`${base}/api/import/preview/${info.id}`)).status, 404);
  assert.equal((await postJson("/api/import/discard", {})).status, 400);
  assert.equal((await postJson("/api/import/process", {})).status, 400);
});

test("http: without an importer the import page and API do not exist", async () => {
  const h = await startPublic();
  try {
    const c = await h.signIn();
    const get = (p: string) => fetch(`${h.base}${p}`, { headers: { Cookie: c } });
    assert.equal((await get("/import")).status, 404);
    assert.equal((await get("/api/import/config")).status, 404);
    for (const p of ["save", "process", "upload"]) {
      assert.equal((await fetch(`${h.base}/api/import/${p}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: c, Origin: h.origin }, body: "{}" })).status, 404);
    }
  } finally { h.close(); }
});
