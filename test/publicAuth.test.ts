import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { ALLOWED_USER, DENIED_USER, good, jsonPost, startPublic, type PublicHarness } from "./helpers/harness.ts";

let h: PublicHarness;
before(async () => { h = await startPublic(); });
after(() => h.close());

const get = (path: string, headers: Record<string, string> = {}) => fetch(h.base + path, { redirect: "manual", headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  jsonPost(h.base + path, body, { Origin: h.origin, ...headers });

test("public: without a session every route is refused (pages redirect to sign-in, the rest get 401)", async () => {
  const page = await get("/", { Accept: "text/html" });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login");
  for (const path of ["/api/sounds", "/api/voice", "/api/status", "/events", "/app.js", "/style.css", "/import", "/logs", "/api/import/config", "/api/logs?type=sound", "/api/import/preview/00000000-0000-0000-0000-000000000000"]) {
    assert.equal((await get(path)).status, 401, path);
  }
  for (const path of ["/api/play", "/api/queue/skip", "/api/queue/remove", "/api/queue/clear-pending", "/api/import/save", "/api/import/process", "/api/import/discard", "/api/import/youtube"]) {
    assert.equal((await post(path, good)).status, 401, path);
  }
  const up = await fetch(`${h.base}/api/import/upload`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Filename": "a.mp3", Origin: h.origin }, body: Buffer.from("x") });
  assert.equal(up.status, 401);
  assert.equal(h.enqueued.length, 0);
});

test("public: the legacy access key is not an authentication path (header, query, cookie, bearer, body)", async () => {
  const KEY = "legacy-local-key-0123456789abcdef";
  const attempts: Record<string, string>[] = [
    { "X-Access-Key": KEY },
    { Authorization: `Bearer ${KEY}` },
    { Cookie: `key=${KEY}; access_key=${KEY}; ACCESS_KEY=${KEY}` },
    { Cookie: `aboda_sid=${KEY}` },
  ];
  for (const headers of attempts) {
    for (const path of ["/api/sounds", `/api/sounds?key=${KEY}`, `/events?key=${KEY}`, "/api/voice", "/api/import/config", "/logs.js"]) {
      assert.equal((await get(path, headers)).status, 401, `${path} ${JSON.stringify(headers)}`);
    }
    assert.equal((await post(`/api/play?key=${KEY}`, { ...good, key: KEY }, headers)).status, 401);
  }
  assert.equal(h.enqueued.length, 0);
});

test("public: sign-in flow sets a hardened session cookie and unlocks the dashboard", async () => {
  const login = await get("/auth/login");
  assert.equal(login.status, 302);
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  assert.ok(state.length >= 24);
  const stateCookie = login.headers.getSetCookie()[0]!;
  assert.match(stateCookie, /HttpOnly/);
  assert.match(stateCookie, /SameSite=Lax/);

  const cb = await get(`/auth/callback?code=${ALLOWED_USER}&state=${state}`, { Cookie: stateCookie.split(";")[0]! });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/");
  const sidCookie = cb.headers.getSetCookie().find((c) => c.startsWith("aboda_sid="))!;
  assert.match(sidCookie, /HttpOnly/);
  assert.match(sidCookie, /SameSite=Lax/);
  assert.match(sidCookie, /Path=\//);
  assert.match(sidCookie, /Max-Age=60/);
  assert.doesNotMatch(sidCookie, /Domain=/);
  assert.ok(cb.headers.getSetCookie().some((c) => c.startsWith("aboda_oauth=;") && /Max-Age=0/.test(c)), "login cookie is cleared");

  const cookie = sidCookie.split(";")[0]!;
  assert.equal((await get("/api/sounds", { Cookie: cookie })).status, 200);
  assert.equal((await get("/", { Cookie: cookie, Accept: "text/html" })).status, 200);
  assert.equal((await get("/app.js", { Cookie: cookie })).status, 200);
  assert.equal((await get("/api/voice", { Cookie: cookie })).status, 200);
  assert.equal((await get("/api/status", { Cookie: cookie })).status, 200);
});

test("public: login CSRF / replay protections on the callback", async () => {
  const start = async () => {
    const r = await get("/auth/login");
    return { state: new URL(r.headers.get("location")!).searchParams.get("state")!, cookie: r.headers.getSetCookie()[0]!.split(";")[0]! };
  };
  const a = await start(), b = await start();
  const hasSession = (r: Response) => r.headers.getSetCookie().some((c) => c.startsWith("aboda_sid=") && !/Max-Age=0/.test(c));

  // state from a different browser (cookie does not match)
  let r = await get(`/auth/callback?code=${ALLOWED_USER}&state=${a.state}`, { Cookie: b.cookie });
  assert.equal(r.status, 400); assert.equal(hasSession(r), false);
  // no login cookie at all (attacker-supplied link)
  r = await get(`/auth/callback?code=${ALLOWED_USER}&state=${a.state}`);
  assert.equal(r.status, 400); assert.equal(hasSession(r), false);
  // made-up state, matching cookie
  r = await get(`/auth/callback?code=${ALLOWED_USER}&state=forged`, { Cookie: "aboda_oauth=forged" });
  assert.equal(r.status, 400);
  // missing code
  r = await get(`/auth/callback?state=${a.state}`, { Cookie: a.cookie });
  assert.equal(r.status, 400);
  // the valid attempt works once, then the state is spent
  r = await get(`/auth/callback?code=${ALLOWED_USER}&state=${b.state}`, { Cookie: b.cookie });
  assert.equal(r.status, 302);
  r = await get(`/auth/callback?code=${ALLOWED_USER}&state=${b.state}`, { Cookie: b.cookie });
  assert.equal(r.status, 400);
  // user pressed "cancel" at Discord
  r = await get(`/auth/callback?error=access_denied&state=${a.state}`, { Cookie: a.cookie });
  assert.equal(r.status, 403);
});

test("public: Discord users who are not authorized, and Discord failures, get no session", async () => {
  const hasSession = (r: Response) => r.headers.getSetCookie().some((c) => c.startsWith("aboda_sid=") && !/Max-Age=0/.test(c));
  for (const [code, status] of [[DENIED_USER, 403], ["boom", 502]] as const) {
    const l = await get("/auth/login");
    const state = new URL(l.headers.get("location")!).searchParams.get("state")!;
    const r = await get(`/auth/callback?code=${code}&state=${state}`, { Cookie: l.headers.getSetCookie()[0]!.split(";")[0]! });
    assert.equal(r.status, status);
    assert.equal(hasSession(r), false);
  }
  // an authorizer that throws fails closed
  const failing = await startPublic({ authorize: async () => { throw new Error("lookup failed"); } });
  try {
    await assert.rejects(failing.signIn(), /sign-in failed \(403\)/);
  } finally { failing.close(); }
});

test("public: writes need the right content type and an Origin that is exactly this site", async () => {
  const cookie = await h.signIn();
  assert.equal((await jsonPost(`${h.base}/api/play`, good, { Cookie: cookie })).status, 403); // no Origin
  assert.equal((await post("/api/play", good, { Cookie: cookie, Origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/play", good, { Cookie: cookie, Origin: h.origin.replace("http:", "https:") })).status, 403);
  const text = await fetch(`${h.base}/api/play`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: h.origin, Cookie: cookie }, body: JSON.stringify(good) });
  assert.equal(text.status, 415);
  assert.equal(h.enqueued.length, 0);
  assert.equal((await post("/api/play", good, { Cookie: cookie })).status, 202);
  assert.equal(h.enqueued.at(-1)?.source, "manual");
  assert.equal((await post("/api/queue/skip", { guildId: good.guildId }, { Cookie: cookie })).status, 200);
});

test("public: foreign Host headers are refused", async () => {
  const status = await new Promise<number>((resolve) => {
    const u = new URL(h.base);
    request({ host: u.hostname, port: u.port, path: "/auth/login", headers: { Host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0)).end();
  });
  assert.equal(status, 421);
});

test("public: static page assets are not reachable without a session (only the sign-in stylesheet is)", async () => {
  assert.equal((await get("/login.css")).status, 200);
  for (const p of ["/app.js", "/style.css", "/index.html", "/import.js", "/logs.js", "/../package.json", "/.env"]) {
    assert.notEqual((await get(p)).status, 200, p);
  }
});

test("public: sessions expire and logout invalidates them and ends event streams", async () => {
  const cookie = await h.signIn();
  assert.equal((await get("/api/sounds", { Cookie: cookie })).status, 200);

  // a live event stream belongs to the session
  const ctl = new AbortController();
  const sse = await fetch(`${h.base}/events`, { headers: { Cookie: cookie }, signal: ctl.signal });
  assert.equal(sse.status, 200);
  const reader = sse.body!.getReader();
  await reader.read();

  const out = await post("/auth/logout", {}, { Cookie: cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie()[0]!, /Max-Age=0/);
  assert.equal((await reader.read()).done, true, "stream was ended by logout");
  assert.equal((await get("/api/sounds", { Cookie: cookie })).status, 401);
  assert.equal((await get("/events", { Cookie: cookie })).status, 401);

  const c2 = await h.signIn();
  h.now.t += 61_000;
  assert.equal((await get("/api/sounds", { Cookie: c2 })).status, 401);
  ctl.abort();
});

test("public: logout is not forgeable cross-origin", async () => {
  const cookie = await h.signIn();
  assert.equal((await jsonPost(`${h.base}/auth/logout`, {}, { Cookie: cookie, Origin: "https://evil.example" })).status, 403);
  assert.equal((await get("/api/sounds", { Cookie: cookie })).status, 200);
  assert.equal((await get("/auth/logout", { Cookie: cookie })).status, 404); // GET is not a logout route; the session is still alive
});

test("public: without OAuth configured nobody can sign in and everything stays closed", async () => {
  const s = await startPublic({ oauth: undefined });
  try {
    assert.equal((await fetch(`${s.base}/auth/login`)).status, 503);
    const page = await fetch(`${s.base}/`, { headers: { Accept: "text/html" }, redirect: "manual" });
    assert.equal(page.headers.get("location"), "/login");
    const login = await fetch(`${s.base}/login`);
    assert.equal(login.status, 503);
    assert.match(await login.text(), /not configured/);
    assert.equal((await fetch(`${s.base}/api/sounds`)).status, 401);
    assert.equal((await fetch(`${s.base}/auth/callback?code=${ALLOWED_USER}&state=x`, { headers: { Cookie: "aboda_oauth=x" } })).status, 503);
  } finally { s.close(); }
});

test("public: __Host- cookies and Secure flag are used for an https public origin", async () => {
  const s = await startPublic({ publicBaseUrl: "https://dash.example.com" });
  try {
    // Host header must match the public hostname, so talk to it with that Host.
    const u = new URL(s.base);
    const res = await new Promise<{ status: number; cookies: string[] }>((resolve) => {
      request({ host: u.hostname, port: u.port, path: "/auth/login", headers: { Host: "dash.example.com" } }, (r) =>
        resolve({ status: r.statusCode ?? 0, cookies: r.headers["set-cookie"] ?? [] })).end();
    });
    assert.equal(res.status, 302);
    assert.match(res.cookies[0]!, /^__Host-aboda_oauth=/);
    assert.match(res.cookies[0]!, /; Secure/);
  } finally { s.close(); }
});
