import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResource } from "../src/voice/AudioProvider.ts";

let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

async function countPackets(file: string) {
  const resource = createResource(file);
  let packets = 0;
  for await (const _ of resource.playStream) packets++;
  return packets;
}

test("mp3 and wav decode through FFmpeg to ~20 ms Opus packets", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "audio-"));
  const mp3 = join(dir, "tone.mp3");
  const wav = join(dir, "tone.wav");
  const gen = ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2"];
  execFileSync("ffmpeg", [...gen, mp3]);
  execFileSync("ffmpeg", [...gen, wav]);
  for (const f of [mp3, wav]) {
    const n = await countPackets(f);
    assert.ok(n >= 95 && n <= 110, `${f}: expected about 100 packets for 2 s, got ${n}`);
  }
});

test("pre-converted .opus plays through the direct (no-FFmpeg) path", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "audio-"));
  const opus = join(dir, "tone.opus");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-ar", "48000", "-ac", "2", "-c:a", "libopus", "-b:a", "64k", opus]);
  const n = await countPackets(opus);
  assert.ok(n >= 95 && n <= 110, `expected about 100 packets, got ${n}`);
});

test("a corrupt file errors instead of hanging", { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "audio-"));
  const bad = join(dir, "bad.mp3");
  (await import("node:fs")).writeFileSync(bad, "this is not audio");
  const n = await Promise.race([
    countPackets(bad).catch(() => -1),
    new Promise<number>((r) => setTimeout(() => r(-2), 8000)),
  ]);
  assert.ok(n <= 0, "corrupt input must yield no audio");
  assert.notEqual(n, -2, "must not hang");
});
