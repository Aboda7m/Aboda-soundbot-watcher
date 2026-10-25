import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/http/auth/sessions.ts";

const USER = { id: "100000000000000002", username: "Bob" };
const DAY = 86_400_000;
const file = () => join(mkdtempSync(join(tmpdir(), "sessions-")), "sessions.json");
const stores: SessionStore[] = [];
const open = (o: ConstructorParameters<typeof SessionStore>[0]) => { const s = new SessionStore(o); stores.push(s); return s; };
import { after } from "node:test";
after(() => stores.forEach((s) => s.close()));

test("a session survives a restart, keeps its absolute deadline, and then expires", () => {
  const p = file();
  let now = 1_000_000;
  const a = open({ maxAgeMs: 30 * DAY, file: p, now: () => now });
  const s = a.create(USER);
  a.close(); // shutdown does not sign anybody out

  now += 10 * DAY;
  const b = open({ maxAgeMs: 30 * DAY, file: p, now: () => now });
  const again = b.get(s.id);
  assert.deepEqual(again?.user, USER);
  assert.equal(again?.id, s.id);
  assert.equal(again?.expiresAt, s.expiresAt, "no sliding window: the deadline is the one from sign-in");

  now += 21 * DAY; // 31 days after sign-in
  assert.equal(b.get(s.id), null);
  const c = open({ maxAgeMs: 30 * DAY, file: p, now: () => now });
  assert.equal(c.size, 0, "expired sessions are not loaded");
});

test("logout (destroy) is persisted: the session stays dead after a restart", () => {
  const p = file();
  const a = open({ maxAgeMs: DAY, file: p });
  const s = a.create(USER);
  const keep = a.create({ id: "100000000000000003", username: "Eve" });
  assert.equal(a.destroy(s.id), true);
  const b = open({ maxAgeMs: DAY, file: p });
  assert.equal(b.get(s.id), null);
  assert.ok(b.get(keep.id));
});

test("only a hash of the session id is on disk, the file is private, and a stored hash is not a usable cookie", () => {
  const p = file();
  const a = open({ maxAgeMs: DAY, file: p });
  const s = a.create(USER);
  const text = readFileSync(p, "utf8");
  assert.ok(!text.includes(s.id), "the id the browser holds is never written");
  if (process.platform !== "win32") assert.equal(statSync(p).mode & 0o077, 0, "owner-only permissions");
  const key = JSON.parse(text).sessions[0].key as string;
  assert.equal(a.get(key), null, "presenting the stored hash as a cookie finds nothing");
  const b = open({ maxAgeMs: DAY, file: p });
  assert.equal(b.get(key), null);
});

test("restored sessions can still be listed and revoked (the periodic recheck path)", () => {
  const p = file();
  open({ maxAgeMs: DAY, file: p }).create(USER);
  const b = open({ maxAgeMs: DAY, file: p });
  const [live] = b.all();
  assert.equal(live?.user.id, USER.id);
  let closed = 0;
  b.attach(live!.id, () => void closed++);
  assert.equal(b.destroy(live!.id), true);
  assert.equal(closed, 1, "its live stream was ended");
  assert.equal(open({ maxAgeMs: DAY, file: p }).size, 0);
});

test("lowering the lifetime also shortens sessions that already exist", () => {
  const p = file();
  let now = 5_000_000;
  open({ maxAgeMs: 30 * DAY, file: p, now: () => now }).create(USER);
  now += 2 * DAY;
  assert.equal(open({ maxAgeMs: DAY, file: p, now: () => now }).size, 0);
});

test("a corrupt file is moved aside, not deleted, and the store starts empty; bad entries are skipped", () => {
  const p = file();
  writeFileSync(p, "{not json");
  const logs: string[] = [];
  const a = open({ maxAgeMs: DAY, file: p, log: (m) => void logs.push(m) });
  assert.equal(a.size, 0);
  assert.equal(readFileSync(`${p}.unreadable`, "utf8"), "{not json");
  assert.ok(logs.some((l) => /could not be read/.test(l)));
  a.create(USER); // and it works afterwards
  assert.equal(open({ maxAgeMs: DAY, file: p }).size, 1);

  const q = file();
  const good = { key: "A".repeat(43), user: USER, createdAt: Date.now(), expiresAt: Date.now() + DAY };
  writeFileSync(q, JSON.stringify({ version: 1, sessions: [{ ...good, key: "short" }, { ...good, user: { id: "x", username: "y" } }, { ...good, expiresAt: "never" }, good] }));
  assert.equal(open({ maxAgeMs: DAY, file: q }).size, 1);
});

test("an unwritable location never breaks sign-in (it just does not persist)", () => {
  const logs: string[] = [];
  const a = open({ maxAgeMs: DAY, file: join(tmpdir(), "no-such-dir-xyz", "s.json"), log: (m) => void logs.push(m) });
  assert.ok(a.create(USER).id);
  assert.ok(logs.some((l) => /Could not save/.test(l)));
});

test("without a file the store is memory-only: close() ends everything, nothing is written", () => {
  const a = open({ maxAgeMs: DAY });
  const s = a.create(USER);
  assert.ok(a.get(s.id));
  a.close();
  assert.equal(a.get(s.id), null);
  assert.equal(existsSync("sessions.json"), false);
});
