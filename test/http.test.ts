import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http/server.ts";
import type { PlayRequest } from "../src/sound/SoundQueue.ts";

const enqueued: PlayRequest[] = [];
let server: Server;
let base = "";
const G = "123456789012345678", C = "223456789012345678";

function start(accessKey: string) {
  return new Promise<void>((resolve) => {
    server = createHttpServer({
      host: "127.0.0.1", port: 0, accessKey,
      watcher: { payloadJson: () => "{}", addClient: () => {} } as never,
      library: { has: (n: string) => n === "airhorn", list: () => ["airhorn"] } as never,
      repo: { sounds: () => [{ name: "airhorn", count: 2, tags: ["x"] }] } as never,
      queue: { enqueue: (r: PlayRequest) => (enqueued.push(r), { ok: true, position: 1 }), status: () => [] } as never,
      canTarget: (g: string, c: string) => g === G && c === C,
    });
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/play`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const good = { sound: "airhorn", guildId: G, channelId: C };

before(() => start(""));
after(() => server.close());

test("lists sounds with metadata", async () => {
  const r = await fetch(`${base}/api/sounds`);
  assert.deepEqual(await r.json(), { sounds: [{ name: "airhorn", count: 2, tags: ["x"] }] });
});
test("valid play request is queued", async () => {
  const r = await post(good);
  assert.equal(r.status, 202);
  assert.equal(enqueued.at(-1)?.source, "manual");
});
test("rejects bad input: type, ids, unknown sound, unknown channel, bad JSON", async () => {
  assert.equal((await post({ ...good, sound: 5 })).status, 400);
  assert.equal((await post({ ...good, guildId: "abc" })).status, 400);
  assert.equal((await post({ ...good, sound: "../x" })).status, 404);
  assert.equal((await post({ ...good, channelId: "323456789012345678" })).status, 404);
  const bad = await fetch(`${base}/api/play`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
});
test("refuses non-JSON content types and cross-origin requests", async () => {
  const text = await fetch(`${base}/api/play`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(good) });
  assert.equal(text.status, 415);
  const n = enqueued.length;
  const evil = await post(good, { Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal(enqueued.length, n);
});
test("rejects foreign Host headers (DNS rebinding) and unknown routes/methods", async () => {
  const r = await new Promise<number>((resolve) => {
    import("node:http").then(({ request }) => {
      const req = request(base + "/api/sounds", { headers: { Host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
  });
  assert.equal(r, 403);
  assert.equal((await fetch(`${base}/api/play`, { method: "DELETE" })).status, 405);
});
test("with ACCESS_KEY: reads and plays need the key", async () => {
  server.close();
  await start("s3cret");
  assert.equal((await fetch(`${base}/api/sounds`)).status, 401);
  assert.equal((await fetch(`${base}/api/sounds?key=s3cret`)).status, 200);
  assert.equal((await post(good)).status, 401);
  assert.equal((await post(good, { "X-Access-Key": "wrong" })).status, 401);
  assert.equal((await post(good, { "X-Access-Key": "s3cret" })).status, 202);
});
