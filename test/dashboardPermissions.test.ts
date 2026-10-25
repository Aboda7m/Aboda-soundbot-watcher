import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { AccessPolicy } from "../src/access/AccessPolicy.ts";
import { createAuthorizer } from "../src/http/auth/authorize.ts";
import { good, jsonPost, startPublic, type PublicHarness } from "./helpers/harness.ts";

const OWNER = "100000000000000001", VIEWER = "100000000000000002", IMPORTER = "100000000000000003", STRANGER = "100000000000000004", BLOCKED = "100000000000000005";

let h: PublicHarness;
const access = AccessPolicy.inMemory([OWNER]);
before(async () => {
  access.grant(VIEWER, "dashboard");
  access.grant(IMPORTER, "dashboard");
  access.grant(IMPORTER, "import");
  access.grant(BLOCKED, "dashboard");
  access.setBlacklist(true);
  access.blockUser(BLOCKED);
  const authorize = createAuthorizer({ userIds: [], roleIds: [], fetchMember: async () => null, extraAllow: (id) => access.can(id, "dashboard"), deny: (id) => access.isBlocked(id) });
  h = await startPublic({ authorize, can: (id, cap) => access.can(id, cap) });
});
after(() => h.close());

const get = (path: string, cookie: string, accept = "application/json") => fetch(`${h.base}${path}`, { headers: { Cookie: cookie, Accept: accept }, redirect: "manual" });
const post = (path: string, cookie: string, body: unknown = {}) => jsonPost(`${h.base}${path}`, body, { Cookie: cookie, Origin: h.origin });

test("sign-in: owners and users granted `dashboard` get in; strangers and blocked users do not", async () => {
  await h.signIn(OWNER);
  await h.signIn(VIEWER);
  await assert.rejects(h.signIn(STRANGER), /sign-in failed \(403\)/);
  await assert.rejects(h.signIn(BLOCKED), /sign-in failed \(403\)/, "blocked beats a grant");
});

test("a user with only `dashboard` can use and play, but not import or read logs", async () => {
  const c = await h.signIn(VIEWER);
  assert.equal((await get("/api/sounds", c)).status, 200);
  assert.equal((await get("/", c, "text/html")).status, 200);
  assert.equal((await post("/api/play", c, good)).status, 202);
  for (const p of ["/import", "/import.js", "/import.css", "/api/import/config", "/logs", "/logs.js", "/api/logs?type=sound"]) {
    assert.equal((await get(p, c)).status, 403, p);
  }
  for (const p of ["/api/import/save", "/api/import/process", "/api/import/upload", "/api/import/youtube"]) {
    assert.equal((await post(p, c)).status, 403, p);
  }
  const page = await get("/import", c, "text/html");
  assert.equal(page.status, 403);
  assert.match(await page.text(), /does not have permission.*Back to the dashboard/s);
  const me = await (await get("/api/me", c)).json();
  assert.deepEqual(me.can, { import: false, logs: false });
  assert.equal(me.user.id, VIEWER);
  assert.equal(h.enqueued.at(-1)?.sound, "airhorn");
});

test("grants and revocations apply at once, without signing in again", async () => {
  const c = await h.signIn(VIEWER);
  assert.equal((await get("/api/import/config", c)).status, 403);
  access.grant(VIEWER, "import");
  assert.notEqual((await get("/api/import/config", c)).status, 403);
  assert.equal((await (await get("/api/me", c)).json()).can.import, true);
  assert.equal((await get("/api/logs?type=sound", c)).status, 403, "other permissions are separate");
  access.revoke(VIEWER, "import");
  assert.equal((await get("/api/import/config", c)).status, 403);
});

test("owners and import-granted users reach their routes", async () => {
  const o = await h.signIn(OWNER);
  for (const p of ["/api/import/config", "/api/logs?type=sound", "/import"]) assert.notEqual((await get(p, o)).status, 403, p);
  const i = await h.signIn(IMPORTER);
  assert.notEqual((await get("/api/import/config", i)).status, 403);
  assert.equal((await get("/api/logs?type=sound", i)).status, 403);
});

test("losing `dashboard` (or being blocked) signs the user out on the very next request and closes their stream", async () => {
  const c = await h.signIn(VIEWER);
  const ctl = new AbortController();
  const sse = await fetch(`${h.base}/events`, { headers: { Cookie: c }, signal: ctl.signal });
  assert.equal(sse.status, 200);
  const reader = sse.body!.getReader();
  await reader.read();

  access.revoke(VIEWER, "dashboard");
  const r = await get("/api/sounds", c);
  assert.equal(r.status, 403);
  assert.match(r.headers.getSetCookie()[0] ?? "", /Max-Age=0/);
  assert.equal((await reader.read()).done, true, "the live stream was ended");
  assert.equal((await get("/api/sounds", c)).status, 401, "the session itself is gone");
  ctl.abort();

  access.grant(VIEWER, "dashboard");
  const c2 = await h.signIn(VIEWER);
  access.blockUser(VIEWER);
  assert.equal((await get("/api/sounds", c2)).status, 403);
  access.unblockUser(VIEWER);
});

test("/api/me needs a session", async () => {
  assert.equal((await fetch(`${h.base}/api/me`)).status, 401);
});
