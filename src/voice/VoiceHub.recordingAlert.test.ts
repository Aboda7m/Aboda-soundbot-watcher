import assert from "node:assert/strict";
import test from "node:test";
import { VoiceHub, type HubSlot } from "./VoiceHub.ts";

/** A fake bot: remembers what it was asked to play and when it was told to leave. */
function fakeSlot(id: string, worker: boolean) {
  const calls = { played: [] as string[], left: 0 };
  let release: (() => void) | null = null;
  let channel: string | null = null;
  const slot: HubSlot = {
    id,
    label: id,
    worker,
    adapter: {
      canServe: () => true,
      channelOf: () => channel,
      connect: async (_g: string, c: string) => {
        channel = c;
        return {} as never;
      },
      play: (_g: string, _c: string, file: string) => {
        calls.played.push(file);
        return new Promise<void>((resolve) => (release = resolve));
      },
      stop: () => {},
      leave: () => {
        calls.left++;
        channel = null;
      },
      destroyAll: () => {},
    },
  };
  return { slot, calls, finish: () => release?.() };
}

test("the alert plays on the recording's own bot, blocks queued sounds meanwhile, and does not touch the other bot", async () => {
  const hub = new VoiceHub();
  const main = fakeSlot("main", false);
  const worker = fakeSlot("worker-1", true);
  hub.addSlot(main.slot);
  hub.addSlot(worker.slot);

  const lease = await hub.leaseRecording("g", "vc"); // a worker is dedicated to the recording
  assert.equal(lease.slotId, "worker-1");

  const alert = hub.playOnRecording("g", "vc", "alert.mp3", 10);
  assert.deepEqual(worker.calls.played, ["alert.mp3"]);
  assert.deepEqual(main.calls.played, []);

  // already playing: a second alert is skipped instead of cutting the first
  assert.equal(await hub.playOnRecording("g", "vc", "alert.mp3"), false);

  // a normal sound for this channel waits for the alert to finish, then plays on the same bot
  const sound = hub.play("g", "vc", "hello.mp3");
  assert.equal(worker.calls.played.length, 1);
  worker.finish();
  assert.equal(await alert, true);
  await Promise.resolve();
  assert.deepEqual(worker.calls.played, ["alert.mp3", "hello.mp3"]);
  worker.finish();
  await sound;
  assert.equal(main.calls.played.length, 0);
});

test("no recording bot in the channel: nothing plays; a failing alert does not break the lease", async () => {
  const hub = new VoiceHub();
  const bot = fakeSlot("main", false);
  hub.addSlot(bot.slot);
  assert.equal(await hub.playOnRecording("g", "vc", "alert.mp3"), false);
  assert.deepEqual(bot.calls.played, []);

  await hub.leaseRecording("g", "vc");
  bot.slot.adapter.play = async () => {
    throw new Error("boom");
  };
  await assert.rejects(hub.playOnRecording("g", "vc", "alert.mp3"), /boom/);
  assert.equal(hub.isLeased("main", "g"), true); // recording still holds its bot
  assert.equal(bot.calls.left, 0);
});

test("recording ended while the alert was playing: the bot leaves once the alert is done", async () => {
  const hub = new VoiceHub();
  const bot = fakeSlot("main", false);
  hub.addSlot(bot.slot);
  const lease = await hub.leaseRecording("g", "vc");
  const alert = hub.playOnRecording("g", "vc", "alert.mp3");
  hub.releaseRecording("g", "vc", lease.slotId);
  assert.equal(bot.calls.left, 0); // busy playing: release did not leave
  bot.finish();
  await alert;
  assert.equal(bot.calls.left, 1);
});
