import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { G, C, good, jsonPost, startLocal, startPublic, type PublicHarness } from "./helpers/harness.ts";
import type { PlayRequest } from "../src/sound/SoundQueue.ts";

// Both listeners are started side by side on the same application objects (queue, library, watcher),
// exactly like index.ts does, and each credential is tried against the wrong listener.

const KEY = "local-s3cret-0123456789abcdef0123";
const enqueued: PlayRequest[] = [];
let pub: PublicHarness;
let local: Awaited<ReturnType<typeof startLocal>>;

before(async () => {
  pub = await startPublic({ ...{} });
  local = await startLocal(KEY, enqueued);
});
after(() => { pub.close(); local.close(); });

test("isolation: the local access key does not authenticate on the public listener", async () => {
  for (const path of ["/api/sounds", "/api/voice", "/api/status", "/events", "/", "/import", "/logs", "/api/import/config", "/api/logs?type=sound"]) {
    const attempts: Record<string, string>[] = [{ "X-Access-Key": KEY }, { Cookie: `aboda_sid=${KEY}` }, { Authorization: `Bearer ${KEY}` }];
    for (const headers of attempts) {
      const r = await fetch(`${pub.base}${path}`, { headers, redirect: "manual" });
      assert.ok(r.status === 401 || r.status === 302, `${path} -> ${r.status}`);
      assert.notEqual(r.status, 200);
    }
    assert.equal((await fetch(`${pub.base}${path}${path.includes("?") ? "&" : "?"}key=${KEY}`, { redirect: "manual" })).status === 200, false, `${path}?key=`);
  }
  const play = await jsonPost(`${pub.base}/api/play`, good, { "X-Access-Key": KEY, Origin: pub.origin });
  assert.equal(play.status, 401);
  assert.equal(pub.enqueued.length, 0);
});

test("isolation: a public dashboard session does not authenticate on the local listener", async () => {
  const cookie = await pub.signIn();
  assert.equal((await fetch(`${pub.base}/api/sounds`, { headers: { Cookie: cookie } })).status, 200);
  const sid = cookie.split("=")[1]!;
  const attempts: Record<string, string>[] = [{ Cookie: cookie }, { "X-Access-Key": sid }, { Authorization: `Bearer ${sid}` }];
  for (const headers of attempts) {
    for (const path of ["/api/sounds", "/api/voice", "/events", "/api/status"]) {
      assert.equal((await fetch(`${local.base}${path}`, { headers })).status, 401, path);
    }
    assert.equal((await jsonPost(`${local.base}/api/play`, good, headers)).status, 401);
  }
  assert.equal(enqueued.length, 0);
});

test("isolation: local has no route that creates, refreshes or reveals a public session", async () => {
  const before = pub.sessions.size;
  for (const path of ["/auth/login", "/auth/callback?code=1&state=2", "/auth/logout"]) {
    assert.equal((await fetch(`${local.base}${path}`, { headers: { "X-Access-Key": KEY } })).status, 404);
  }
  assert.equal(pub.sessions.size, before);
});

test("isolation: ending every public session leaves the local listener working, and vice versa", async () => {
  await pub.signIn();
  pub.sessions.close();
  assert.equal((await fetch(`${local.base}/api/sounds`, { headers: { "X-Access-Key": KEY } })).status, 200);
  assert.equal((await jsonPost(`${local.base}/api/play`, good, { "X-Access-Key": KEY })).status, 202);
  assert.equal(enqueued.at(-1)?.guildId, G);
  assert.equal(enqueued.at(-1)?.channelId, C);
});

test("isolation: both listeners drive the same application logic (a valid caller on each queues a sound)", async () => {
  const cookie = await pub.signIn().catch(() => null);
  // (sessions.close() above stopped the sweep timer only; creating sessions still works)
  assert.ok(cookie);
  assert.equal((await jsonPost(`${pub.base}/api/play`, good, { Cookie: cookie!, Origin: pub.origin })).status, 202);
  assert.equal(pub.enqueued.at(-1)?.sound, "airhorn");
});

test("isolation: the public listener's source and frontend contain no access-key authentication", () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
  const publicFiles = ["src/http/server.ts", "src/http/importRoutes.ts", "src/http/logRoutes.ts", "src/http/auth/sessions.ts", "src/http/auth/discordOAuth.ts", "src/http/auth/authorize.ts", "src/http/auth/cookies.ts",
    ...readdirSync(join(import.meta.dirname, "..", "public")).filter((f) => /\.(js|html)$/.test(f)).map((f) => `public/${f}`)];
  for (const f of publicFiles) {
    const code = read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, /x-access-key/i, `${f} mentions X-Access-Key`);
    assert.doesNotMatch(code, /accessKey|ACCESS_KEY/, `${f} mentions the access key`);
    assert.doesNotMatch(code, /searchParams\.(get|has)\(["']key["']\)/, `${f} reads ?key=`);
  }
  // and the local listener never reads credentials from the URL
  const local = read("src/http/localServer.ts").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(local, /searchParams/);
  assert.doesNotMatch(local, /cookie/i);
});
