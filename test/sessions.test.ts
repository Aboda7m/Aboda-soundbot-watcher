import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/http/auth/sessions.ts";

const user = { id: "1".repeat(18), username: "u" };

test("sessions: random ids, lookup, expiry is absolute (use does not extend it)", () => {
  const now = { t: 0 };
  const s = new SessionStore({ maxAgeMs: 1000, now: () => now.t, sweepMs: 3_600_000 });
  const a = s.create(user), b = s.create(user);
  assert.notEqual(a.id, b.id);
  assert.ok(a.id.length >= 40);
  now.t = 900;
  assert.equal(s.get(a.id)?.user.id, user.id);
  now.t = 1000; // touching it at 900 must not have extended it
  assert.equal(s.get(a.id), null);
  assert.equal(s.get("nope"), null);
  s.close();
});

test("sessions: destroy runs attached closers once; late attach closes immediately", () => {
  const s = new SessionStore({ maxAgeMs: 1000, sweepMs: 3_600_000 });
  const a = s.create(user);
  let closed = 0;
  s.attach(a.id, () => closed++);
  const detach = s.attach(a.id, () => closed += 100);
  detach();
  assert.equal(s.destroy(a.id), true);
  assert.equal(closed, 1);
  assert.equal(s.destroy(a.id), false);
  s.attach(a.id, () => closed++);
  assert.equal(closed, 2);
  s.close();
});

test("sessions: expiry sweep closes streams; cap evicts the oldest", () => {
  const now = { t: 0 };
  const s = new SessionStore({ maxAgeMs: 1000, maxSessions: 2, now: () => now.t, sweepMs: 3_600_000 });
  const a = s.create(user), b = s.create(user), c = s.create(user);
  assert.equal(s.get(a.id), null);
  assert.ok(s.get(b.id) && s.get(c.id));
  let closed = false;
  s.attach(b.id, () => (closed = true));
  now.t = 5000;
  s.sweep();
  assert.equal(closed, true);
  assert.equal(s.size, 0);
  s.close();
});
