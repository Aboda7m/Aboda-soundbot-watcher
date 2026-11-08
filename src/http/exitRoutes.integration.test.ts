import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleExitRoute } from "./exitRoutes.ts";

const userId = "111111111111111";
const otherId = "222222222222222";

function harness(initial?: string) {
  let stored: string | undefined = initial;
  const writes: Array<{ userId: string; sound: string }> = [];
  const clears: string[] = [];
  const d: any = {
    library: { has: (n: string) => n === "sound-one", resolve: () => null },
    repo: {
      exit: () => stored,
      setExit: (u: string, s: string) => { stored = s; writes.push({ userId: u, sound: s }); },
      clearExit: (u: string) => { stored = undefined; clears.push(u); return true; },
    },
  };
  const res: any = {
    status: 0, body: "",
    writeHead(status: number) { this.status = status; return this; },
    end(body = "") { this.body = String(body); return this; },
  };
  const kit: any = { user: { id: userId, username: "me" }, guard: () => true };
  return { d, res, kit, writes, clears };
}
const post = (body: unknown) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST" }) as any;
const get = () => ({ method: "GET" }) as any;

test("GET /api/exit returns the caller's sound", async () => {
  const h = harness("sound-one");
  assert.equal(await handleExitRoute(h.d, get(), h.res, new URL("http://l/api/exit"), h.kit), true);
  assert.equal(h.res.status, 200);
  const body = JSON.parse(h.res.body);
  assert.equal(body.sound, "sound-one");
  assert.equal(body.exists, true);
});

test("GET /api/exit with nothing set returns null", async () => {
  const h = harness();
  await handleExitRoute(h.d, get(), h.res, new URL("http://l/api/exit"), h.kit);
  assert.deepEqual(JSON.parse(h.res.body).sound, null);
});

test("POST /api/exit sets the sound for the signed-in account only", async () => {
  const h = harness();
  await handleExitRoute(h.d, post({ userId: otherId, sound: "sound-one" }), h.res, new URL("http://l/api/exit"), h.kit);
  assert.equal(h.res.status, 200);
  assert.deepEqual(h.writes, [{ userId, sound: "sound-one" }]);
});

test("POST /api/exit rejects unknown and malformed sounds", async () => {
  const a = harness();
  await handleExitRoute(a.d, post({ sound: "nope" }), a.res, new URL("http://l/api/exit"), a.kit);
  assert.equal(a.res.status, 404);
  const b = harness();
  await handleExitRoute(b.d, post({ sound: 5 }), b.res, new URL("http://l/api/exit"), b.kit);
  assert.equal(b.res.status, 400);
  assert.deepEqual([...a.writes, ...b.writes], []);
});

test("POST /api/exit/clear clears the caller's sound", async () => {
  const h = harness("sound-one");
  await handleExitRoute(h.d, post({}), h.res, new URL("http://l/api/exit/clear"), h.kit);
  assert.equal(h.res.status, 200);
  assert.deepEqual(h.clears, [userId]);
});

test("non-Discord sessions are refused", async () => {
  const h = harness();
  h.kit.user.id = "local-key";
  await handleExitRoute(h.d, get(), h.res, new URL("http://l/api/exit"), h.kit);
  assert.equal(h.res.status, 403);
});

test("unrelated paths are not handled", async () => {
  const h = harness();
  assert.equal(await handleExitRoute(h.d, get(), h.res, new URL("http://l/api/entrance"), h.kit), false);
});
