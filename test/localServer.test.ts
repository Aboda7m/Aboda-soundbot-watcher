import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createLocalServer } from "../src/http/localServer.ts";
import { G, C, coreDeps, good, jsonPost, startLocal } from "./helpers/harness.ts";

const KEY = "local-s3cret-0123456789abcdef0123";
let l: Awaited<ReturnType<typeof startLocal>>;
before(async () => { l = await startLocal(KEY); });
after(() => l.close());

const K = { "X-Access-Key": KEY };
const get = (path: string, headers: Record<string, string> = {}) => fetch(l.base + path, { headers });

test("local: the key is required in a header on every route, reads and SSE included", async () => {
  for (const path of ["/api/sounds", "/api/voice", "/api/status", "/events"]) {
    assert.equal((await get(path)).status, 401, path);
    assert.equal((await get(path, { "X-Access-Key": "wrong" })).status, 401, path);
  }
  assert.equal((await jsonPost(`${l.base}/api/play`, good)).status, 401);
  assert.equal((await jsonPost(`${l.base}/api/play`, good, { "X-Access-Key": "wrong" })).status, 401);
  assert.equal(l.enqueued.length, 0);

  assert.deepEqual(await (await get("/api/sounds", K)).json(), { sounds: [{ name: "airhorn", count: 2, tags: ["x"] }] });
  assert.equal((await get("/api/voice", K)).status, 200);
  assert.equal((await get("/api/status", K)).status, 200);
  const ctl = new AbortController();
  const sse = await fetch(`${l.base}/events`, { headers: K, signal: ctl.signal });
  assert.equal(sse.status, 200);
  ctl.abort();
  assert.equal((await jsonPost(`${l.base}/api/play`, good, K)).status, 202);
  assert.equal(l.enqueued.at(-1)?.source, "manual");
  assert.equal((await jsonPost(`${l.base}/api/queue/skip`, { guildId: G }, K)).status, 200);
});

test("local: the key is never accepted from the URL (query string, even alongside nothing else)", async () => {
  for (const path of ["/api/sounds", "/api/voice", "/events", "/api/status"]) {
    for (const q of ["key", "access_key", "ACCESS_KEY", "accessKey", "token"]) {
      assert.equal((await get(`${path}?${q}=${KEY}`)).status, 401, `${path}?${q}`);
    }
  }
  assert.equal((await jsonPost(`${l.base}/api/play?key=${KEY}`, good)).status, 401);
  // the URL key is ignored rather than trusted: a header is still what decides
  assert.equal((await get(`/api/sounds?key=wrong`, K)).status, 200);
  // not accepted from a cookie or Authorization header either
  assert.equal((await get("/api/sounds", { Cookie: `key=${KEY}; ACCESS_KEY=${KEY}` })).status, 401);
  assert.equal((await get("/api/sounds", { Authorization: `Bearer ${KEY}` })).status, 401);
});

test("local: the key is never echoed back", async () => {
  const r = await get("/api/sounds", { "X-Access-Key": KEY + "x" });
  const body = await r.text();
  assert.ok(!body.includes(KEY));
  for (const [, v] of r.headers) assert.ok(!v.includes(KEY));
});

test("local: serves only the playback/voice API (no pages, import, logs, or login routes)", async () => {
  for (const path of ["/", "/index.html", "/app.js", "/style.css", "/import", "/import.js", "/logs", "/logs.js", "/api/import/config", "/api/logs?type=sound", "/auth/login", "/auth/callback", "/auth/logout", "/api/import/preview/00000000-0000-0000-0000-000000000000"]) {
    assert.equal((await get(path, K)).status, 404, path);
  }
  for (const path of ["/api/import/upload", "/api/import/save", "/api/import/youtube", "/auth/logout"]) {
    assert.equal((await jsonPost(`${l.base}${path}`, {}, K)).status, 404, path);
  }
});

test("local: input validation, content type, origin and method rules are unchanged", async () => {
  const bad = (b: unknown) => jsonPost(`${l.base}/api/play`, b, K);
  assert.equal((await bad({ ...good, sound: 5 })).status, 400);
  assert.equal((await bad({ ...good, guildId: "abc" })).status, 400);
  assert.equal((await bad({ ...good, sound: "../x" })).status, 404);
  assert.equal((await bad({ ...good, channelId: "323456789012345678" })).status, 404);
  const nojson = await fetch(`${l.base}/api/play`, { method: "POST", headers: { "Content-Type": "application/json", ...K }, body: "{nope" });
  assert.equal(nojson.status, 400);
  const text = await fetch(`${l.base}/api/play`, { method: "POST", headers: { "Content-Type": "text/plain", ...K }, body: JSON.stringify(good) });
  assert.equal(text.status, 415);
  const n = l.enqueued.length;
  assert.equal((await jsonPost(`${l.base}/api/play`, good, { ...K, Origin: "https://evil.example" })).status, 403);
  assert.equal(l.enqueued.length, n);
  assert.equal((await fetch(`${l.base}/api/play`, { method: "DELETE", headers: K })).status, 405);
  assert.equal((await fetch(`${l.base}/api/play`, { method: "OPTIONS", headers: K })).status, 405); // no CORS preflight approval
});

test("local: foreign Host headers are refused on a loopback bind (DNS rebinding)", async () => {
  const u = new URL(l.base);
  const status = await new Promise<number>((resolve) =>
    request({ host: u.hostname, port: u.port, path: "/api/sounds", headers: { Host: "evil.example", ...K } }, (res) => resolve(res.statusCode ?? 0)).end());
  assert.equal(status, 403);
});

test("local: refuses to be created without an access key", () => {
  assert.throws(() => createLocalServer({ ...coreDeps(), host: "127.0.0.1", accessKey: "" }), /without an access key/);
});
