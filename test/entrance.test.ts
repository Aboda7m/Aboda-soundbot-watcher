import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_USER, jsonPost, startPublic, type PublicHarness } from "./helpers/harness.ts";

const OTHER = "523456789012345678";
const BYTES = Buffer.from("ID3-not-really-an-mp3");

let h: PublicHarness;
let dir: string;
let dashboardAllowed = true;
const entrances = new Map<string, string>();
const writes: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "entrance-test-"));
  writeFileSync(join(dir, "airhorn.mp3"), BYTES);
  const files: Record<string, string> = { airhorn: join(dir, "airhorn.mp3"), gone: join(dir, "missing.mp3") };
  h = await startPublic({
    authorize: async () => true,
    can: () => dashboardAllowed,
    library: {
      has: (n: string) => Object.hasOwn(files, n),
      list: () => Object.keys(files),
      resolve: (n: string) => (Object.hasOwn(files, n) ? files[n]! : null),
    } as never,
    repo: {
      sounds: () => [],
      entrance: (id: string) => entrances.get(id),
      setEntrance: (id: string, s: string) => (writes.push(`${id}=${s}`), void entrances.set(id, s)),
      clearEntrance: (id: string) => entrances.delete(id),
    } as never,
  });
});
after(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, cookie?: string, accept = "application/json") =>
  fetch(h.base + path, { redirect: "manual", headers: { Accept: accept, ...(cookie ? { Cookie: cookie } : {}) } });
const post = (path: string, cookie: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  jsonPost(h.base + path, body, { Cookie: cookie, Origin: h.origin, ...headers });

test("entrance: without a session the page redirects to sign-in and every route answers 401", async () => {
  const page = await get("/entrance", undefined, "text/html");
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login");
  for (const p of ["/entrance.js", "/entrance.css", "/api/entrance", "/api/entrance/preview?sound=airhorn"]) {
    assert.equal((await get(p)).status, 401, p);
  }
  for (const p of ["/api/entrance", "/api/entrance/clear"]) {
    assert.equal((await jsonPost(h.base + p, { sound: "airhorn" }, { Origin: h.origin })).status, 401, p);
  }
  assert.equal(entrances.size, 0);
});

test("entrance: signed in, the page and its assets are served with a CSP that allows blob audio only", async () => {
  const c = await h.signIn("323456789012345678");
  const page = await get("/entrance", c, "text/html");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.headers.get("content-security-policy") ?? "", /media-src blob:/);
  assert.match(await page.text(), /My entrance sound/);
  assert.equal((await get("/entrance.js", c)).status, 200);
  assert.equal((await get("/entrance.css", c)).status, 200);
});

test("entrance: a user sets, reads and clears only their own entrance sound; the id comes from the session", async () => {
  const a = await h.signIn("323456789012345678");
  const b = await h.signIn(OTHER);

  let me = await (await get("/api/entrance", a)).json();
  assert.deepEqual(me, { user: { id: "323456789012345678", username: "user-323456789012345678" }, sound: null, exists: false });

  // A body that names another user is ignored: there is no such field.
  const set = await post("/api/entrance", a, { sound: "airhorn", userId: OTHER, id: OTHER });
  assert.equal(set.status, 200);
  assert.equal(entrances.get("323456789012345678"), "airhorn");
  assert.equal(entrances.has(OTHER), false);

  me = await (await get("/api/entrance", a)).json();
  assert.equal(me.sound, "airhorn");
  assert.equal(me.exists, true);
  assert.equal((await (await get("/api/entrance", b)).json()).sound, null, "the other user is unaffected");

  // Same value again = no second write.
  const before = writes.length;
  assert.equal((await post("/api/entrance", a, { sound: "airhorn" })).status, 200);
  assert.equal(writes.length, before);

  assert.equal((await post("/api/entrance", b, { sound: "airhorn" })).status, 200);
  assert.equal((await post("/api/entrance/clear", a)).status, 200);
  assert.equal(entrances.has("323456789012345678"), false);
  assert.equal(entrances.get(OTHER), "airhorn", "clearing is per user too");
  entrances.clear();
});

test("entrance: a sound that was removed from the library is reported as missing", async () => {
  const c = await h.signIn("323456789012345678");
  entrances.set("323456789012345678", "deleted-sound");
  const me = await (await get("/api/entrance", c)).json();
  assert.equal(me.sound, "deleted-sound");
  assert.equal(me.exists, false);
  entrances.clear();
});

test("entrance: bad input is refused and nothing is written", async () => {
  const c = await h.signIn("323456789012345678");
  const n = writes.length;
  assert.equal((await post("/api/entrance", c, { sound: "nope" })).status, 404);
  assert.equal((await post("/api/entrance", c, { sound: "../../etc/passwd" })).status, 404);
  assert.equal((await post("/api/entrance", c, { sound: 5 })).status, 400);
  assert.equal((await post("/api/entrance", c, {})).status, 400);
  assert.equal((await post("/api/entrance", c, { sound: "" })).status, 400);
  assert.equal(writes.length, n);
  assert.equal(entrances.size, 0);
});

test("entrance: POSTs need the site's Origin and a JSON content type", async () => {
  const c = await h.signIn("323456789012345678");
  const noOrigin = await jsonPost(h.base + "/api/entrance", { sound: "airhorn" }, { Cookie: c });
  assert.equal(noOrigin.status, 403);
  const evil = await jsonPost(h.base + "/api/entrance", { sound: "airhorn" }, { Cookie: c, Origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  const form = await fetch(h.base + "/api/entrance", {
    method: "POST",
    headers: { Cookie: c, Origin: h.origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: "sound=airhorn",
  });
  assert.equal(form.status, 415);
  const clear = await jsonPost(h.base + "/api/entrance/clear", {}, { Cookie: c });
  assert.equal(clear.status, 403);
  assert.equal(entrances.size, 0);
});

test("entrance: preview streams the sound file; unknown names and vanished files are 404", async () => {
  const c = await h.signIn("323456789012345678");
  const ok = await get("/api/entrance/preview?sound=airhorn", c);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), BYTES);
  for (const q of ["nope", "../airhorn", "", "gone"]) {
    assert.equal((await get(`/api/entrance/preview?sound=${encodeURIComponent(q)}`, c)).status, 404, q);
  }
});

test("entrance: losing the dashboard permission locks the page out at once", async () => {
  const c = await h.signIn("323456789012345678");
  assert.equal((await get("/api/entrance", c)).status, 200);
  dashboardAllowed = false;
  try {
    assert.equal((await get("/api/entrance", c)).status, 403);
    assert.equal((await post("/api/entrance", c, { sound: "airhorn" })).status, 401, "the session was ended");
  } finally {
    dashboardAllowed = true;
  }
  assert.equal(entrances.size, 0);
});
