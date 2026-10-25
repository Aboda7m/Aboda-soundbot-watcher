import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { isPrivateNetworkHost } from "../src/http/common.ts";
import { good, startLocal, startPublic } from "./helpers/harness.ts";

const KEY = "local-s3cret-0123456789abcdef0123";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const servers: { close(): void }[] = [];
after(() => servers.forEach((s) => s.close()));
const fresh = async (opts?: Parameters<typeof startLocal>[2]) => { const s = await startLocal(KEY, [], opts); servers.push(s); return s; };

const signIn = async (base: string, key = KEY) =>
  fetch(`${base}/auth/key-login`, { method: "POST", headers: { ...FORM, Origin: base }, body: new URLSearchParams({ key }), redirect: "manual" });
const sidOf = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("aboda_local_sid="))?.split(";")[0] ?? "";

test("local dashboard: the browser gets a key sign-in form, and a key in the URL does nothing", async () => {
  const l = await fresh();
  for (const url of ["/", `/?key=${KEY}`, `/?access_key=${KEY}&key=${KEY}`]) {
    const r = await fetch(l.base + url);
    assert.equal(r.status, 200, url);
    const html = await r.text();
    assert.match(html, /<input type="password" name="key"/);
    assert.match(html, /method="post" action="\/auth\/key-login"/);
    assert.ok(!html.includes(KEY));
    assert.doesNotMatch(html, /<script/i);
    assert.equal(r.headers.get("referrer-policy"), "same-origin", "so a browser form post carries a real Origin, not null");
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'.*form-action 'self'/);
  }
  for (const p of ["/app.js", "/style.css", "/api/sounds", "/api/me", "/events"]) assert.equal((await fetch(l.base + p + `?key=${KEY}`)).status, 401, p);
  assert.equal((await fetch(`${l.base}/login.css`)).status, 200);
});

test("local dashboard: right key -> HttpOnly Strict session cookie -> dashboard works; wrong key -> nothing", async () => {
  const l = await fresh();
  const bad = await signIn(l.base, "wrong");
  assert.equal(bad.status, 401);
  assert.equal(sidOf(bad), "");
  assert.match(await bad.text(), /not correct/);

  const ok = await signIn(l.base);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/");
  const raw = ok.headers.getSetCookie().find((c) => c.startsWith("aboda_local_sid="))!;
  assert.match(raw, /HttpOnly/); assert.match(raw, /SameSite=Strict/); assert.match(raw, /Path=\//);
  assert.ok(!raw.includes(KEY));
  const cookie = raw.split(";")[0]!;

  const get = (p: string) => fetch(l.base + p, { headers: { Cookie: cookie } });
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Soundboard/);
  assert.equal((await get("/app.js")).status, 200);
  assert.equal((await get("/api/sounds")).status, 200);
  assert.deepEqual((await (await get("/api/me")).json()).can, { import: false, logs: false });
  for (const p of ["/import", "/logs", "/api/import/config", "/api/logs?type=sound", "/auth/login"]) assert.equal((await get(p)).status, 404, `${p} does not exist here, even signed in`);

  // writes from the signed-in browser must come from this very site
  const play = (headers: Record<string, string>) => fetch(`${l.base}/api/play`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...headers }, body: JSON.stringify(good) });
  assert.equal((await play({})).status, 403, "no Origin");
  assert.equal((await play({ Origin: "https://evil.example" })).status, 403);
  assert.equal((await play({ Origin: l.base })).status, 202);
});

test("local dashboard: form login rejects wrong content type and cross-site posts; tools with the header still work", async () => {
  const l = await fresh();
  assert.equal((await fetch(`${l.base}/auth/key-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: KEY }) })).status, 415);
  assert.equal((await fetch(`${l.base}/auth/key-login`, { method: "POST", headers: { ...FORM, Origin: "https://evil.example" }, body: new URLSearchParams({ key: KEY }) })).status, 403);
  assert.equal((await fetch(`${l.base}/auth/key-login?key=${KEY}`, { method: "POST", headers: { ...FORM, Origin: l.base }, body: "" })).status, 401, "a key in the URL is not read");
  assert.equal((await fetch(`${l.base}/api/sounds`, { headers: { "X-Access-Key": KEY } })).status, 200);
});

test("local dashboard: guessing the key is rate-limited per address", async () => {
  const l = await fresh();
  for (let i = 0; i < 8; i++) assert.equal((await signIn(l.base, `guess${i}`)).status, 401);
  const blocked = await signIn(l.base, KEY);
  assert.equal(blocked.status, 429, "even the right key is refused while blocked");
  assert.equal(sidOf(blocked), "");
  assert.equal(blocked.headers.get("retry-after"), "600");
});

test("local dashboard: logout ends the session and its live stream", async () => {
  const l = await fresh();
  const cookie = sidOf(await signIn(l.base));
  const ctl = new AbortController();
  const sse = await fetch(`${l.base}/events`, { headers: { Cookie: cookie }, signal: ctl.signal });
  assert.equal(sse.status, 200);
  const reader = sse.body!.getReader();
  await reader.read();
  assert.equal((await fetch(`${l.base}/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "https://evil.example" }, body: "{}" })).status, 403);
  const out = await fetch(`${l.base}/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: l.base }, body: "{}" });
  assert.equal(out.status, 200);
  assert.equal((await reader.read()).done, true);
  assert.equal((await fetch(`${l.base}/api/sounds`, { headers: { Cookie: cookie } })).status, 401);
  ctl.abort();
});

test("local dashboard: sessions of the two listeners are not interchangeable", async () => {
  const l = await fresh();
  const pub = await startPublic(); servers.push(pub);
  const localCookie = sidOf(await signIn(l.base));
  const publicCookie = await pub.signIn();
  assert.equal((await fetch(`${pub.base}/api/sounds`, { headers: { Cookie: localCookie } })).status, 401);
  assert.equal((await fetch(`${pub.base}/api/sounds`, { headers: { Cookie: localCookie.replace("aboda_local_sid", "aboda_sid") } })).status, 401);
  assert.equal((await fetch(`${l.base}/api/sounds`, { headers: { Cookie: publicCookie } })).status, 401);
  assert.equal((await fetch(`${l.base}/api/sounds`, { headers: { Cookie: publicCookie.replace("aboda_sid", "aboda_local_sid") } })).status, 401);
});

test("local host rule: a LAN bind answers IP literals and PC names, not public-looking names (DNS rebinding)", async () => {
  for (const ok of ["192.168.1.20", "192.168.1.20:3940", "[fe80::1]:3940", "soundpc", "soundpc:3940", "my-pc.local:3940", "nas.lan", "x.home.arpa"]) assert.equal(isPrivateNetworkHost(ok), true, ok);
  for (const bad of ["evil.example", "evil.example:3940", "192.168.1.20.evil.example", "localhost.evil.com", "", undefined, "a b", "x.local.evil.com"]) assert.equal(isPrivateNetworkHost(bad), false, String(bad));

  const lan = await fresh({ host: "192.168.1.20" }); // pretend-bound: the harness listens on loopback
  const asHost = (h: string, base: string) => new Promise<number>((resolve) => {
    const u = new URL(base);
    request({ host: u.hostname, port: u.port, path: "/", headers: { Host: h } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).end();
  });
  assert.equal(await asHost("192.168.1.20:3940", lan.base), 200);
  assert.equal(await asHost("soundpc:3940", lan.base), 200);
  assert.equal(await asHost("evil.example", lan.base), 403);
  const loop = await fresh();
  assert.equal(await asHost("192.168.1.20:3940", loop.base), 403, "a loopback bind still only answers loopback names");
});
