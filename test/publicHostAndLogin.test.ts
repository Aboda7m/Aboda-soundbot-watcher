import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { createDiscordOAuth } from "../src/http/auth/discordOAuth.ts";
import { ALLOWED_USER, freePort, jsonPost, startPublic, good } from "./helpers/harness.ts";

/** Raw request so the Host header (and any forwarding headers) can be chosen freely. */
const raw = (base: string, path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve) => {
    const u = new URL(base);
    request({ host: u.hostname, port: u.port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).end();
  });

test("host: only the configured public host is served; everything else is a 421 with no echo", async () => {
  const h = await startPublic(); // PUBLIC_BASE_URL = http://127.0.0.1:<port>
  const warn = console.warn; const logged: string[] = [];
  console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const host = new URL(h.base).host;
    assert.equal((await raw(h.base, "/login", { Host: host })).status, 200);
    assert.equal((await raw(h.base, "/login", { Host: host.toUpperCase() })).status, 200, "host names are case-insensitive");
    const port = new URL(h.base).port;
    for (const bad of [`localhost:${port}`, `evil.example`, `127.0.0.1`, `127.0.0.1:1`, `192.168.1.20:${port}`, `${host}.evil.example`, `[::1]:${port}`]) {
      const r = await raw(h.base, "/login", { Host: bad });
      assert.equal(r.status, 421, bad);
      assert.ok(!r.body.includes(bad) && !r.body.includes(host), "the response does not echo the Host or reveal the expected one");
    }
    // the owner's console says exactly what was refused and what is expected, once per distinct value
    assert.ok(logged.some((l) => l.includes('Host "localhost:') && l.includes(host) && l.includes("PUBLIC_BASE_URL")));
    const n = logged.length;
    await raw(h.base, "/login", { Host: "evil.example" });
    assert.equal(logged.length, n, "repeat offenders are not logged again");
  } finally { console.warn = warn; h.close(); }
});

test("host: forwarding headers sent by a client never make a wrong Host acceptable (and never change cookie flags)", async () => {
  const h = await startPublic();
  try {
    const host = new URL(h.base).host;
    const spoof = { "X-Forwarded-Host": host, Forwarded: `host=${host};proto=http`, "X-Original-Host": host, "X-Host": host, "X-Forwarded-Server": host };
    assert.equal((await raw(h.base, "/login", { Host: "evil.example", ...spoof })).status, 421);
    // a right Host with hostile forwarding headers is served normally, and Secure is still decided by PUBLIC_BASE_URL alone
    const ok = await raw(h.base, "/auth/login", { Host: host, "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https", "CF-Visitor": '{"scheme":"https"}' });
    assert.equal(ok.status, 302);
    const cookie = String((ok.headers["set-cookie"] ?? [])[0]);
    assert.match(cookie, /^aboda_oauth=/);
    assert.doesNotMatch(cookie, /Secure/);
  } finally { h.close(); }
});

test("host: behind Cloudflare the public hostname (no port) is what must arrive; https base gives Secure __Host- cookies", async () => {
  const h = await startPublic({ publicBaseUrl: "https://dash.example.com" });
  try {
    const ok = await raw(h.base, "/auth/login", { Host: "dash.example.com", "X-Forwarded-Proto": "http" });
    assert.equal(ok.status, 302);
    const cookie = String((ok.headers["set-cookie"] ?? [])[0]);
    assert.match(cookie, /^__Host-aboda_oauth=/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    // what a mis-set `httpHostHeader` (rewriting Host to the origin address) would look like: refused, not accepted
    assert.equal((await raw(h.base, "/", { Host: "localhost:3939", Accept: "text/html" })).status, 421);
    assert.equal((await raw(h.base, "/", { Host: "127.0.0.1:3939", Accept: "text/html" })).status, 421);
    assert.equal((await raw(h.base, "/", { Host: "dash.example.com:443", Accept: "text/html" })).status, 421);
  } finally { h.close(); }
});

test("login page: a Login with Discord button, no script, no credentials; signed-in users skip it", async () => {
  const h = await startPublic();
  try {
    const page = await fetch(`${h.base}/login`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<a class="btn" href="\/auth\/login">Login with Discord<\/a>/);
    assert.doesNotMatch(html, /<script|<input|<form|password|client_secret|client_id/i);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal((await fetch(`${h.base}/login.css`)).status, 200);
    const cookie = await h.signIn();
    const again = await fetch(`${h.base}/login`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(again.status, 302);
    assert.equal(again.headers.get("location"), "/");
    // sign-in problems are shown on the same page, as fixed text only
    const denied = await fetch(`${h.base}/auth/callback?error=access_denied&state=x`, { headers: { Cookie: "aboda_oauth=x" } });
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /Sign-in was cancelled/);
  } finally { h.close(); }
});

test("oauth (real client, mocked Discord): PKCE S256 binds login to the server, and the client secret never leaves the server", async () => {
  const SECRET = "TOP-SECRET-CLIENT-SECRET-VALUE";
  const TOKEN = "TOP-SECRET-ACCESS-TOKEN";
  const discord: { url: string; body: string }[] = [];
  const fakeDiscord = (async (url: string, init?: RequestInit) => {
    discord.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/oauth2/token")) return Response.json({ access_token: TOKEN });
    if (url.endsWith("/users/@me")) return Response.json({ id: ALLOWED_USER, username: "me" });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

  const out: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a: unknown[]) => void out.push(a.join(" "));
  const h = await startPublic({ oauth: createDiscordOAuth({ clientId: "1234", clientSecret: SECRET, redirectUri: "http://127.0.0.1/auth/callback" }, fakeDiscord) });
  try {
    const seen: string[] = [];
    const login = await fetch(`${h.base}/auth/login`, { redirect: "manual" });
    const location = login.headers.get("location")!;
    seen.push(location, ...login.headers.getSetCookie(), await login.text());
    const u = new URL(location);
    assert.equal(u.origin + u.pathname, "https://discord.com/oauth2/authorize");
    assert.equal(u.searchParams.get("scope"), "identify");
    assert.equal(u.searchParams.get("client_id"), "1234");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    const state = u.searchParams.get("state")!;
    const challenge = u.searchParams.get("code_challenge")!;

    const cb = await fetch(`${h.base}/auth/callback?code=abc&state=${state}`, { redirect: "manual", headers: { Cookie: login.headers.getSetCookie()[0]!.split(";")[0]! } });
    assert.equal(cb.status, 302);
    seen.push(...cb.headers.getSetCookie());
    const tokenCall = discord.find((c) => c.url.endsWith("/oauth2/token"))!;
    const form = new URLSearchParams(tokenCall.body);
    assert.equal(form.get("client_secret"), SECRET, "the secret goes to Discord's token endpoint...");
    assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge, "...together with the verifier matching the challenge");
    assert.ok(!location.includes(form.get("code_verifier")!), "the verifier is not in the browser URL");

    const cookie = cb.headers.getSetCookie().find((c) => c.startsWith("aboda_sid="))!.split(";")[0]!;
    for (const path of ["/", "/app.js", "/api/sounds", "/api/voice", "/api/status", "/login"]) {
      const r = await fetch(`${h.base}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });
      seen.push(await r.text(), ...[...r.headers].map(([k, v]) => `${k}: ${v}`));
    }
    await jsonPost(`${h.base}/api/play`, good, { Cookie: cookie, Origin: h.origin });
    // a replayed callback and a failing Discord must not leak either
    const replay = await fetch(`${h.base}/auth/callback?code=abc&state=${state}`, { headers: { Cookie: login.headers.getSetCookie()[0]!.split(";")[0]! } });
    seen.push(await replay.text());
    for (const text of [...seen, ...out]) {
      assert.ok(!text.includes(SECRET), "client secret leaked");
      assert.ok(!text.includes(TOKEN), "access token leaked");
    }
  } finally { Object.assign(console, saved); h.close(); }
});

test("sessions are re-authorized: a definite 'no' ends the session and its stream, an unknown answer does not", async () => {
  let verdict: boolean | null = true;
  const h = await startPublic({ recheck: async () => verdict, recheckMs: 25 });
  try {
    const cookie = await h.signIn();
    const ctl = new AbortController();
    const sse = await fetch(`${h.base}/events`, { headers: { Cookie: cookie }, signal: ctl.signal });
    const reader = sse.body!.getReader();
    await reader.read();

    verdict = null; // Discord unreachable
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await fetch(`${h.base}/api/sounds`, { headers: { Cookie: cookie } })).status, 200);

    verdict = false; // removed from the server / lost the role
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await fetch(`${h.base}/api/sounds`, { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await reader.read()).done, true, "the live stream was closed");
    ctl.abort();
  } finally { h.close(); }
});

test("a port picked by the harness is free (sanity for the tests above)", async () => {
  assert.ok((await freePort()) > 1023);
});
