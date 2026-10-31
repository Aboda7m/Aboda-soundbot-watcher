import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FollowRecorder, type FollowContext } from "./FollowRecorder.ts";
import { FollowStore } from "./FollowStore.ts";

const fakeRecorder = (store: FollowStore) => {
  const started: string[] = [];
  const rec = new FollowRecorder({
    store,
    voiceHub: {
      leaseRecording: async () => ({ connection: {}, slotId: "s1" }) as never,
      releaseRecording: () => {},
    },
    manager: {
      startSession: async (_g: string, channelId: string) => {
        started.push(channelId);
        return { sessionId: "sess", channelId, durationSeconds: 1, startedAt: new Date() } as never;
      },
      stopSession: async () => null as never,
    },
    log: () => {},
  });
  return { rec, started };
};
const ctx: FollowContext = { initiatedByName: "Boss", notifyChannelId: "text1" };

test("attach is saved, survives shutdown, is restored, and detach removes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "follows-"));
  const file = join(dir, "record-follows.json");
  try {
    const a = fakeRecorder(new FollowStore(file, () => {}));
    await a.rec.attach({ guildId: "g1", targetId: "u1", initiatedBy: "o1", targetChannelId: null, context: ctx });
    await a.rec.shutdown(); // restart: must NOT erase the saved follow
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { follows: { guildId: string; targetId: string; notifyChannelId: string }[] };
    assert.equal(onDisk.follows.length, 1);
    assert.equal(onDisk.follows[0]!.targetId, "u1");
    assert.equal(onDisk.follows[0]!.notifyChannelId, "text1");

    // "new process": fresh store + recorder, target is already in voice
    const store = new FollowStore(file, () => {});
    const b = fakeRecorder(store);
    const n = await b.rec.restore(store.all(), () => ({ context: ctx, targetChannelId: "vc9" }));
    assert.equal(n, 1);
    assert.deepEqual(b.started, ["vc9"]);
    assert.equal(b.rec.get("g1")?.targetId, "u1");

    await b.rec.detach("g1");
    assert.equal(new FollowStore(file, () => {}).all().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an entry that cannot be resolved yet stays saved; a corrupt file is kept aside", async () => {
  const dir = mkdtempSync(join(tmpdir(), "follows-"));
  const file = join(dir, "record-follows.json");
  try {
    const store = new FollowStore(file, () => {});
    store.set({ guildId: "g1", targetId: "u1", initiatedBy: "o1", createdAt: "x" });
    const { rec } = fakeRecorder(store);
    assert.equal(await rec.restore(store.all(), () => null), 0);
    assert.equal(new FollowStore(file, () => {}).all().length, 1);

    const bad = join(dir, "bad.json");
    (await import("node:fs")).writeFileSync(bad, "{not json");
    assert.equal(new FollowStore(bad, () => {}).all().length, 0);
    assert.equal(existsSync(bad), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
