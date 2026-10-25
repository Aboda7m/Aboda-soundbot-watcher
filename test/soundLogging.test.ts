import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { VoicePort } from "../src/voice/VoicePort.ts";

// The logger resolves its file from process.cwd() when the module loads, so move into a
// scratch directory *before* importing anything that pulls the logger in.
const originalCwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sound-log-test-"));
process.chdir(scratch);

const { SoundQueue } = await import("../src/sound/SoundQueue.ts");
const { handleLogRoute } = await import("../src/http/logRoutes.ts");

type PlayRequest = Parameters<InstanceType<typeof SoundQueue>["enqueue"]>[0];

const LOG_FILE = path.join(scratch, "sound-play-logs.json");

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(LOG_FILE, { recursive: true, force: true });
  for (const f of fs.readdirSync(scratch)) {
    if (f.startsWith("sound-play-logs.")) fs.rmSync(path.join(scratch, f), { recursive: true, force: true });
  }
});

/** Fake voice layer. `behavior` decides what each play() call does. */
function makeQueue(behavior: (path: string) => Promise<void> = async () => {}) {
  const messages: string[] = [];
  const played: string[] = [];
  const voice: VoicePort = {
    play: async (_g, _c, p) => {
      played.push(p);
      await behavior(p);
    },
    stop: () => {},
    leave: () => {},
    destroyAll: () => {},
  };
  const queue = new SoundQueue({
    voice,
    resolvePath: (name) => (name === "missing" ? null : `/sounds/${name}.mp3`),
    maxPerGuild: 10,
    idleLeaveMs: 0,
    log: (m) => void messages.push(m),
  });
  return { queue, messages, played };
}

async function drain(queue: InstanceType<typeof SoundQueue>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (queue.status().length === 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("queue did not drain");
}

const readLog = (): Record<string, unknown>[] => JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));

const manual = (over: Partial<PlayRequest> = {}): PlayRequest => ({
  sound: "airhorn",
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  source: "manual",
  requestedBy: { userId: "333333333333333333", username: "caller" },
  ...over,
});

describe("logging is connected to actual playback", () => {
  it("records exactly one entry per successful play, with the requester preserved", async () => {
    const { queue } = makeQueue();
    assert.equal(queue.enqueue(manual()).ok, true);
    await drain(queue);

    const logs = readLog();
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.sound, "airhorn");
    assert.equal(logs[0]!.userId, "333333333333333333");
    assert.equal(logs[0]!.username, "caller");
    assert.equal(logs[0]!.source, "manual");
    assert.equal(logs[0]!.trigger, "text-command");
    assert.equal(typeof logs[0]!.timestamp, "string");
  });

  it("does not log a sound whose playback failed", async () => {
    const { queue, messages } = makeQueue(async () => {
      throw new Error("voice connection failed");
    });
    queue.enqueue(manual());
    await drain(queue);

    assert.equal(fs.existsSync(LOG_FILE), false);
    assert.equal(messages.length, 1);
  });

  it("does not log requests that were never enqueued (unknown sound, duplicate)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { queue } = makeQueue(() => gate);

    assert.deepEqual(queue.enqueue(manual({ sound: "missing" })), { ok: false, reason: "unknown-sound" });

    assert.equal(queue.enqueue(manual({ sound: "a" })).ok, true); // starts playing, waits on gate
    assert.equal(queue.enqueue(manual({ sound: "b" })).ok, true); // queued
    assert.deepEqual(queue.enqueue(manual({ sound: "b" })), { ok: false, reason: "duplicate" });

    release();
    await drain(queue);

    assert.deepEqual(readLog().map((r) => r.sound), ["a", "b"]);
  });

  it("logs an automatic play honestly: no user, auto trigger", async () => {
    const { queue } = makeQueue();
    queue.enqueue({ sound: "welcome", guildId: "1", channelId: "2", source: "entrance" });
    await drain(queue);

    const [rec] = readLog();
    assert.equal(rec!.userId, null);
    assert.equal(rec!.username, null);
    assert.equal(rec!.trigger, "auto-entrance");
  });
});

describe("logging failures and damaged files", () => {
  it("a failure to WRITE the log is not reported as a failure to PLAY, and the queue keeps going", async () => {
    fs.mkdirSync(LOG_FILE); // a directory where the file should be: every write fails
    const { queue, messages, played } = makeQueue();
    queue.enqueue(manual({ sound: "one" }));
    queue.enqueue(manual({ sound: "two" }));
    await drain(queue);

    assert.equal(played.length, 2, "both sounds still played");
    assert.ok(messages.length >= 1, "the problem was reported");
    assert.ok(
      messages.every((m) => !/could not play/i.test(m)),
      `log-write failures must not be reported as playback failures, got: ${JSON.stringify(messages)}`,
    );
  });

  it("a damaged log file is kept aside, not silently overwritten", async () => {
    const damaged = '[{"timestamp":"2026-01-01T00:00:00.000Z","sound":"old","guildId":"1"},{"sound":"half-wri';
    fs.writeFileSync(LOG_FILE, damaged, "utf8");

    const { queue } = makeQueue();
    queue.enqueue(manual());
    await drain(queue);

    assert.equal(readLog().length, 1, "new log starts with the new entry");
    const kept = fs.readdirSync(scratch).filter((f) => f.startsWith("sound-play-logs.corrupt-"));
    assert.equal(kept.length, 1, "the damaged file was preserved");
    assert.equal(fs.readFileSync(path.join(scratch, kept[0]!), "utf8"), damaged);
  });

  it("appends to an existing valid log without losing earlier entries", async () => {
    const { queue } = makeQueue();
    queue.enqueue(manual({ sound: "first" }));
    await drain(queue);
    queue.enqueue(manual({ sound: "second" }));
    await drain(queue);
    assert.deepEqual(readLog().map((r) => r.sound), ["first", "second"]);
  });
});

describe("log file -> /api/logs response", () => {
  async function callApi(query: string) {
    let status = 0;
    let body: any;
    const res = {} as ServerResponse;
    const req = { method: "GET" } as IncomingMessage;
    const handled = await handleLogRoute(
      { soundPlayFile: LOG_FILE, voiceActivityFile: path.join(scratch, "none.json") },
      req,
      res,
      new URL(`http://local/api/logs?${query}`),
      { json: (_r, s, b) => ((status = s), (body = b)) },
    );
    return { handled, status, body };
  }

  it("exposes username, userId and the other fields the viewer renders", async () => {
    const { queue } = makeQueue();
    queue.enqueue(manual());
    queue.enqueue({ sound: "bye", guildId: "9", channelId: "8", source: "exit" });
    await drain(queue);

    const { handled, status, body } = await callApi("type=sound");
    assert.equal(handled, true);
    assert.equal(status, 200);
    assert.equal(body.total, 2);
    const [human, auto] = body.entries;
    assert.equal(human.username, "caller");
    assert.equal(human.userId, "333333333333333333");
    assert.equal(auto.username, null);
    assert.equal(auto.userId, null);
    assert.equal(auto.trigger, "auto-exit");
    for (const k of ["timestamp", "sound", "guildId", "channelId", "source", "trigger", "userId", "username"]) {
      assert.ok(k in human, `field ${k} present in API response`);
    }
  });
});
