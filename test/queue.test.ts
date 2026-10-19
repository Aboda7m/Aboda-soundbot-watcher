import { test } from "node:test";
import assert from "node:assert/strict";
import { SoundQueue, type PlayRequest } from "../src/sound/SoundQueue.ts";
import type { VoicePort } from "../src/voice/VoicePort.ts";

function fakeVoice(opts: { fail?: Set<string>; hold?: boolean } = {}) {
  const log: string[] = [];
  const active = new Map<string, number>();
  const gates: Array<() => void> = [];
  let maxParallelSameGuild = 0;
  const port: VoicePort = {
    async play(guildId, channelId, filePath) {
      active.set(guildId, (active.get(guildId) ?? 0) + 1);
      maxParallelSameGuild = Math.max(maxParallelSameGuild, active.get(guildId)!);
      log.push(`play ${guildId}/${channelId}/${filePath}`);
      try {
        if (opts.fail?.has(filePath)) throw new Error("boom");
        if (opts.hold) await new Promise<void>((r) => gates.push(r));
        else await new Promise((r) => setImmediate(r));
      } finally {
        active.set(guildId, active.get(guildId)! - 1);
      }
    },
    stop: (g) => { log.push(`stop ${g}`); gates.splice(0).forEach((r) => r()); },
    leave: (g) => { log.push(`leave ${g}`); },
    destroyAll: () => { log.push("destroyAll"); },
  };
  return { port, log, gates, maxParallel: () => maxParallelSameGuild };
}
const req = (sound: string, guildId = "g1", channelId = "c1"): PlayRequest => ({ sound, guildId, channelId, source: "manual" });
const make = (v: VoicePort, extra: object = {}) =>
  new SoundQueue({ voice: v, resolvePath: (n) => (n === "ghost" ? null : n), maxPerGuild: 3, idleLeaveMs: 0, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 30));

test("plays in order, one at a time per guild, counts plays, leaves when empty", async () => {
  const v = fakeVoice();
  const played: string[] = [];
  const q = make(v.port, { onPlayed: (n: string) => played.push(n) });
  q.enqueue(req("a")); q.enqueue(req("b")); q.enqueue(req("c"));
  await settle();
  assert.deepEqual(played, ["a", "b", "c"]);
  assert.equal(v.maxParallel(), 1);
  assert.equal(v.log.at(-1), "leave g1");
  assert.deepEqual(q.status(), []);
});

test("different guilds play in parallel", async () => {
  const v = fakeVoice({ hold: true });
  const q = make(v.port);
  q.enqueue(req("a", "g1")); q.enqueue(req("b", "g2"));
  await settle();
  assert.equal(v.gates.length, 2);
  assert.equal(q.status().length, 2);
  v.gates.splice(0).forEach((r) => r());
  await settle();
});

test("rejects unknown sounds, duplicates and a full queue", async () => {
  const v = fakeVoice({ hold: true });
  const q = make(v.port);
  assert.deepEqual(q.enqueue(req("ghost")), { ok: false, reason: "unknown-sound" });
  assert.equal(q.enqueue(req("a")).ok, true);   // starts playing, leaves the waiting list
  await settle();
  assert.equal(q.enqueue(req("b")).ok, true);
  assert.deepEqual(q.enqueue(req("b")), { ok: false, reason: "duplicate" });
  assert.equal(q.enqueue(req("c")).ok, true);
  assert.equal(q.enqueue(req("d")).ok, true);
  assert.deepEqual(q.enqueue(req("e")), { ok: false, reason: "queue-full" });
  q.shutdown();
});

test("a failing sound is skipped and the queue keeps going", async () => {
  const v = fakeVoice({ fail: new Set(["bad"]) });
  const played: string[] = [];
  const errors: string[] = [];
  const q = make(v.port, { onPlayed: (n: string) => played.push(n), log: (m: string) => errors.push(m) });
  q.enqueue(req("a")); q.enqueue(req("bad")); q.enqueue(req("c"));
  await settle();
  assert.deepEqual(played, ["a", "c"]);
  assert.equal(errors.length, 1);
});

test("skip and clear stop playback; clear drops waiting items", async () => {
  const v = fakeVoice({ hold: true });
  const played: string[] = [];
  const q = make(v.port, { onPlayed: (n: string) => played.push(n) });
  q.enqueue(req("a")); q.enqueue(req("b")); q.enqueue(req("c"));
  await settle();
  q.skip("g1");
  await settle();
  assert.deepEqual(played, ["a"]);
  assert.equal(q.status()[0]?.current?.sound, "b");
  q.clear("g1");
  await settle();
  assert.deepEqual(q.status(), []);
  assert.deepEqual(played, ["a", "b"]);
});

test("idle leave waits, and a new sound cancels it", async () => {
  const v = fakeVoice();
  const q = make(v.port, { idleLeaveMs: 80 });
  q.enqueue(req("a"));
  await settle();
  assert.equal(v.log.includes("leave g1"), false);
  q.enqueue(req("b"));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(v.log.includes("leave g1"), false);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(v.log.filter((l) => l === "leave g1").length, 1);
});

test("shutdown refuses new work and destroys voice", () => {
  const v = fakeVoice();
  const q = make(v.port);
  q.shutdown();
  assert.deepEqual(q.enqueue(req("a")), { ok: false, reason: "shutting-down" });
  assert.equal(v.log.includes("destroyAll"), true);
});
