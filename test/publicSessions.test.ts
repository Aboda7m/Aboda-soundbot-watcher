// Drives the real public listener (createPublicServer) with a fake Discord and a persistent session file.
// Self-contained: it does not use test/helpers/harness.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import { createServer as createNet } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicServer } from "../src/http/server.ts";
import { SessionStore } from "../src/http/auth/sessions.ts";

const USER = { id: "100000000000000002", username: "Bob" };
const DAY = 86_400_000;
const freePort = () => new Promise<number>((res) => { const s = createNet().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string; cookies: string[] }
const send = (port: number, host: string, method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  new Promise<Res>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers } }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b, cookies: (res.headers["set-cookie"] ?? []) as string[] }));
    });
    r.on("error", reject); r.end(body);
  });

const cleanup: (() => void)[] = [];
after(() => cleanup.forEach((f) => f()));

async function boot(opts: { file: string; baseUrl?: string; now?: () => number; maxAgeMs?: number }) {
  const port = await freePort();
  const baseUrl = (opts.baseUrl ?? "http://localhost:{port}").replace("{port}", String(port));
  const host = new URL(baseUrl).host;
  const sessions = new SessionStore({ maxAgeMs: opts.maxAgeMs ?? 30 * DAY, file: opts.file, ...(opts.now ? { now: opts.now } : {}) });
  const played: unknown[] = [];
  const targets: unknown[][] = [];
  const server: Server = createPublicServer({
    publicBaseUrl: baseUrl,
    sessions,
    oauth: { authorizeUrl: (state) => `https://discord.test/authorize?state=${state}`, completeLogin: async () => USER },
    authorize: async () => true,
    can: () => true,
    watcher: {} as never,
    library: { has: () => true, list: () => ["airhorn"] } as never,
    repo: { sounds: () => [] } as never,
    queue: { enqueue: (r: unknown) => (played.push(r), { ok: true, position: 1 }), status: () => ({}) } as never,
    canTarget: (...a: unknown[]) => (targets.push(a), true),
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  let closed = false;
  const stop = () => { if (!closed) { closed = true; server.close(); server.closeAllConnections(); sessions.close(); } };
  cleanup.push(stop);
  const origin = new URL(baseUrl).origin;
  return { port, host, origin, stop, sessions, played, targets,
    get: (path: string, headers: Record<string, string> = {}) => send(port, host, "GET", path, headers),
    post: (path: string, headers: Record<string, string> = {}, body = "{}") =>
      send(port, host, "POST", path, { "content-type": "application/json", origin, ...headers }, body) };
}

const cookieOf = (r: Res, name: string) => r.cookies.find((c) => c.includes(`${name}=`));
const pair = (c: string) => c.split(";")[0]!;

/** The browser side of the Discord login: /auth/login, then /auth/callback with the state and the bound cookie. */
async function signIn(s: Awaited<ReturnType<typeof boot>>) {
  const login = await s.get("/auth/login");
  assert.equal(login.status, 302);
  const state = new URL(String(login.headers.location)).searchParams.get("state")!;
  const oauthCookie = pair(cookieOf(login, "oauth")!);
  const cb = await s.get(`/auth/callback?state=${state}&code=abc`, { cookie: oauthCookie });
  return { login, state, oauthCookie, cb };
}

test("sign-in sets a persistent HttpOnly SameSite=Lax cookie of the configured lifetime (30 days)", async () => {
  const s = await boot({ file: join(mkdtempSync(join(tmpdir(), "ps-")), "sessions.json") });
  const { cb } = await signIn(s);
  assert.equal(cb.status, 302);
  const sid = cookieOf(cb, "aboda_sid")!;
  assert.match(sid, /; HttpOnly/);
  assert.match(sid, /; SameSite=Lax/);
  assert.match(sid, new RegExp(`; Max-Age=${30 * 86400}\\b`));
  assert.doesNotMatch(sid, /; Secure/, "plain http (development) has no Secure flag");
  assert.doesNotMatch(sid, /Domain=/);
});

test("the session cookie keeps working after the bot restarts, and the file holds no raw cookie value", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ps-")), "sessions.json");
  const a = await boot({ file });
  const sid = pair(cookieOf((await signIn(a)).cb, "aboda_sid")!);
  const me = await a.get("/api/me", { cookie: sid });
  assert.equal(me.status, 200);
  assert.deepEqual(JSON.parse(me.body).user, USER);
  a.stop(); // shutdown

  assert.ok(!readFileSync(file, "utf8").includes(sid.split("=")[1]!));
  const b = await boot({ file }); // a new process: new store, new in-memory login states
  const again = await b.get("/api/me", { cookie: sid });
  assert.equal(again.status, 200, "no Discord login needed after a restart");
  assert.equal(JSON.parse(again.body).user.username, "Bob");
});

test("logout invalidates the session for good (also after a restart)", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ps-")), "sessions.json");
  const a = await boot({ file });
  const sid = pair(cookieOf((await signIn(a)).cb, "aboda_sid")!);
  const out = await a.post("/auth/logout", { cookie: sid });
  assert.equal(out.status, 200);
  assert.match(cookieOf(out, "aboda_sid")!, /Max-Age=0/);
  assert.equal((await a.get("/api/me", { cookie: sid })).status, 401);
  a.stop();
  assert.equal((await (await boot({ file })).get("/api/me", { cookie: sid })).status, 401);
  // logging out needs the same-site Origin: a cross-site page cannot sign the user out
  const b = await boot({ file });
  const sid2 = pair(cookieOf((await signIn(b)).cb, "aboda_sid")!);
  assert.equal((await b.post("/auth/logout", { cookie: sid2, origin: "https://evil.example" })).status, 403);
  assert.equal((await b.get("/api/me", { cookie: sid2 })).status, 200);
});

test("a session expires at its absolute deadline, restart or not", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ps-")), "sessions.json");
  let now = Date.now();
  const a = await boot({ file, now: () => now });
  const sid = pair(cookieOf((await signIn(a)).cb, "aboda_sid")!);
  now += 29 * DAY;
  assert.equal((await a.get("/api/me", { cookie: sid })).status, 200);
  a.stop();
  const b = await boot({ file, now: () => now });
  assert.equal((await b.get("/api/me", { cookie: sid })).status, 200);
  now += 2 * DAY;
  assert.equal((await b.get("/api/me", { cookie: sid })).status, 401);
});

test("OAuth state is still enforced: wrong cookie, unknown state, replay and missing code are refused", async () => {
  const s = await boot({ file: join(mkdtempSync(join(tmpdir(), "ps-")), "sessions.json") });
  const one = await signIn(s);
  assert.equal(one.cb.status, 302);
  const replay = await s.get(`/auth/callback?state=${one.state}&code=abc`, { cookie: one.oauthCookie });
  assert.equal(replay.status, 400, "a state is single-use");
  assert.equal(cookieOf(replay, "aboda_sid"), undefined);

  const two = await s.get("/auth/login");
  const st = new URL(String(two.headers.location)).searchParams.get("state")!;
  assert.equal((await s.get(`/auth/callback?state=${st}&code=abc`, { cookie: "aboda_oauth=other" })).status, 400, "state not bound to this browser");
  assert.equal((await s.get(`/auth/callback?state=${st}&code=abc`)).status, 400, "no binding cookie at all");
  assert.equal((await s.get(`/auth/callback?state=forged&code=abc`, { cookie: "aboda_oauth=forged" })).status, 400, "a state we never issued");
  assert.equal((await s.get(`/auth/callback?state=${st}`, { cookie: pair(cookieOf(two, "oauth")!) })).status, 400, "no code");
});

test("behind https the cookies are __Host- prefixed, Secure, HttpOnly and last 30 days", async () => {
  const s = await boot({ file: join(mkdtempSync(join(tmpdir(), "ps-")), "sessions.json"), baseUrl: "https://dash.example.com" });
  const { login, cb } = await signIn(s);
  assert.match(cookieOf(login, "__Host-aboda_oauth")!, /; Secure/);
  const sid = cookieOf(cb, "__Host-aboda_sid")!;
  assert.match(sid, /; Secure/);
  assert.match(sid, /; HttpOnly/);
  assert.match(sid, new RegExp(`Max-Age=${30 * 86400}\\b`));
});

test("dashboard playback is attributed to the signed-in Discord account and checked against that user", async () => {
  const s = await boot({ file: join(mkdtempSync(join(tmpdir(), "ps-")), "sessions.json") });
  const sid = pair(cookieOf((await signIn(s)).cb, "aboda_sid")!);
  const r = await s.post("/api/play", { cookie: sid }, JSON.stringify({ sound: "airhorn", guildId: "200000000000000001", channelId: "300000000000000001" }));
  assert.equal(r.status, 202);
  assert.deepEqual((s.played[0] as { requestedBy: unknown }).requestedBy, { userId: USER.id, username: "Bob" });
  assert.deepEqual(s.targets[0], ["200000000000000001", "300000000000000001", USER.id], "canTarget learns who is asking (owners bypass whitelist/blacklist)");
});
