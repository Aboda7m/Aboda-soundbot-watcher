import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { good, jsonPost, startPublic, type PublicHarness } from "./helpers/harness.ts";

// Behaviour of the dashboard API (public listener) for a signed-in user. Authentication itself is covered in
// publicAuth.test.ts; the local listener in localServer.test.ts.
let h: PublicHarness;
let cookie = "";
before(async () => { h = await startPublic(); cookie = await h.signIn(); });
after(() => h.close());

const post = (body: unknown, headers: Record<string, string> = {}) =>
  jsonPost(`${h.base}/api/play`, body, { Cookie: cookie, Origin: h.origin, ...headers });

test("lists sounds with metadata", async () => {
  const r = await fetch(`${h.base}/api/sounds`, { headers: { Cookie: cookie } });
  assert.deepEqual(await r.json(), { sounds: [{ name: "airhorn", count: 2, tags: ["x"] }] });
});
test("valid play request is queued", async () => {
  const r = await post(good);
  assert.equal(r.status, 202);
  assert.equal(h.enqueued.at(-1)?.source, "manual");
});
test("rejects bad input: type, ids, unknown sound, unknown channel, bad JSON", async () => {
  assert.equal((await post({ ...good, sound: 5 })).status, 400);
  assert.equal((await post({ ...good, guildId: "abc" })).status, 400);
  assert.equal((await post({ ...good, sound: "../x" })).status, 404);
  assert.equal((await post({ ...good, channelId: "323456789012345678" })).status, 404);
  const bad = await fetch(`${h.base}/api/play`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: h.origin }, body: "{nope" });
  assert.equal(bad.status, 400);
});
test("refuses non-JSON content types and cross-origin requests", async () => {
  const text = await fetch(`${h.base}/api/play`, { method: "POST", headers: { "Content-Type": "text/plain", Cookie: cookie, Origin: h.origin }, body: JSON.stringify(good) });
  assert.equal(text.status, 415);
  const n = h.enqueued.length;
  const evil = await post(good, { Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal(h.enqueued.length, n);
});
test("rejects foreign Host headers (DNS rebinding) and unknown routes/methods", async () => {
  const u = new URL(h.base);
  const r = await new Promise<number>((resolve) =>
    request({ host: u.hostname, port: u.port, path: "/api/sounds", headers: { Host: "evil.example", Cookie: cookie } }, (res) => resolve(res.statusCode ?? 0)).end());
  assert.notEqual(r, 200);
  assert.equal((await fetch(`${h.base}/api/play`, { method: "DELETE", headers: { Cookie: cookie } })).status, 405);
  assert.equal((await fetch(`${h.base}/api/nope`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await jsonPost(`${h.base}/api/nope`, {}, { Cookie: cookie, Origin: h.origin })).status, 404);
});
