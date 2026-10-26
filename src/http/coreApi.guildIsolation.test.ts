import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleCoreApi } from "./coreApi.ts";

function harness(options: { allowed?: string[]; playback?: Array<{ guildId: string; current: null; queued: number; items: unknown[] }> } = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const response: any = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status: number, headers: Record<string, string> = {}) { this.status = status; this.headers = headers; return this; },
    end(body = "") { this.body = String(body); this.writableEnded = true; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
  };
  const d: any = {
    watcher: { payloadJson: (ids?: readonly string[]) => { calls.push({ name: "snapshot", args: [ids] }); return JSON.stringify({ guilds: [] }); }, addClient: async (_res: unknown, getAllowed?: () => Promise<readonly string[]>) => { calls.push({ name: "sse-filter", args: [getAllowed ? await getAllowed() : undefined] }); } },
    library: { has: () => true },
    repo: { sounds: () => [] },
    queue: {
      status: () => options.playback ?? [],
      enqueue: (...args: unknown[]) => { calls.push({ name: "enqueue", args }); return { ok: true, position: 1 }; },
      removeQueued: (...args: unknown[]) => { calls.push({ name: "remove", args }); return true; },
      skipCurrent: (...args: unknown[]) => { calls.push({ name: "skip", args }); return true; },
      clearPending: (...args: unknown[]) => { calls.push({ name: "clear-pending", args }); },
    },
    accessibleGuildIds: async () => options.allowed ?? ["111111111111111"],
    canTarget: () => true,
  };
  const kit: any = { user: { id: "222222222222222", username: "test" }, guard: () => true };
  return { calls, response, d, kit };
}

function post(body: unknown) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST" });
}

test("voice snapshot receives only the authenticated user's accessible guild IDs", async () => {
  const h = harness({ allowed: ["111111111111111"] });
  await handleCoreApi(h.d, { method: "GET" } as any, h.response, new URL("http://local/api/voice"), h.kit);
  assert.deepEqual(h.calls.find((c) => c.name === "snapshot")?.args, [["111111111111111"]]);
});

test("status API excludes playback for unauthorized guilds", async () => {
  const h = harness({
    allowed: ["111111111111111"],
    playback: [
      { guildId: "111111111111111", current: null, queued: 1, items: [] },
      { guildId: "333333333333333", current: null, queued: 1, items: [] },
    ],
  });
  await handleCoreApi(h.d, { method: "GET" } as any, h.response, new URL("http://local/api/status"), h.kit);
  assert.deepEqual(JSON.parse(h.response.body).playback.map((x: { guildId: string }) => x.guildId), ["111111111111111"]);
});

test("playback refuses a guild outside the user's accessible guilds", async () => {
  const h = harness({ allowed: ["111111111111111"] });
  await handleCoreApi(h.d, post({ sound: "sound", guildId: "333333333333333", channelId: "444444444444444" }) as any, h.response, new URL("http://local/api/play"), h.kit);
  assert.equal(h.response.status, 404);
  assert.equal(h.calls.some((c) => c.name === "enqueue"), false);
});

test("queue controls refuse a guild outside the user's accessible guilds", async () => {
  const h = harness({ allowed: ["111111111111111"] });
  await handleCoreApi(h.d, post({ guildId: "333333333333333" }) as any, h.response, new URL("http://local/api/queue/skip"), h.kit);
  assert.equal(h.response.status, 404);
  assert.equal(h.calls.some((c) => c.name === "skip"), false);
});

test("queue controls allow a guild in the user's accessible guilds", async () => {
  const h = harness({ allowed: ["111111111111111"] });
  await handleCoreApi(h.d, post({ guildId: "111111111111111" }) as any, h.response, new URL("http://local/api/queue/skip"), h.kit);
  assert.equal(h.response.status, 200);
  assert.equal(h.calls.some((c) => c.name === "skip"), true);
});


test("SSE connection and reconnect both resolve the user's accessible guilds", async () => {
  const h = harness({ allowed: ["111111111111111"] });
  for (let i = 0; i < 2; i++) {
    await handleCoreApi(h.d, { method: "GET" } as any, h.response, new URL("http://local/events"), h.kit);
  }
  assert.deepEqual(h.calls.filter((c) => c.name === "sse-filter").map((c) => c.args[0]), [
    ["111111111111111"],
    ["111111111111111"],
  ]);
});
