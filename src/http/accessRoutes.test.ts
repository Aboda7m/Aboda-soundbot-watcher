import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { AccessPolicy } from "../access/AccessPolicy.ts";
import { SessionStore } from "./auth/sessions.ts";
import { handleAccessRoute } from "./accessRoutes.ts";

const OWNER = "111111111111111";
const MANAGER = "222222222222222";
const TARGET = "333333333333333";

function request(method: string, body?: unknown) {
  const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { "content-type": "application/json", origin: "https://dashboard.example" };
  return req;
}
function response() {
  return {
    status: 0,
    body: "",
    writeHead(status: number) { this.status = status; return this; },
    end(body = "") { this.body = String(body); return this; },
  } as any;
}
function guard(req: any, res: any) {
  if (req.headers["content-type"] !== "application/json" || req.headers.origin !== "https://dashboard.example") {
    res.writeHead(403).end(JSON.stringify({ error: "guard failed" })); return false;
  }
  return true;
}

test("normal user cannot access bot-user management API", async () => {
  const access = AccessPolicy.inMemory([OWNER]);
  const sessions = new SessionStore({ maxAgeMs: 60_000, sweepMs: 60_000 });
  const res = response();
  try {
    assert.equal(await handleAccessRoute({ access, sessions, can: (id, cap) => access.can(id, cap) }, request("GET"), res, new URL("https://dashboard.example/api/access/users"), { user: { id: MANAGER, username: "member" }, guard }), true);
    assert.equal(res.status, 403);
  } finally { sessions.close(); }
});

test("access manager can only delegate permissions they already have", async () => {
  const access = AccessPolicy.inMemory([OWNER]);
  access.setCapabilities(MANAGER, ["dashboard", "logs", "access.manage"]);
  const sessions = new SessionStore({ maxAgeMs: 60_000, sweepMs: 60_000 });
  try {
    const denied = response();
    await handleAccessRoute({ access, sessions, can: (id, cap) => access.can(id, cap) }, request("POST", { userId: TARGET, role: "admin", capabilities: ["dashboard", "import", "entrance.manage", "logs"] }), denied, new URL("https://dashboard.example/api/access/users/update"), { user: { id: MANAGER, username: "manager" }, guard });
    assert.equal(denied.status, 403);
    assert.deepEqual(access.capabilitiesFor(TARGET), []);

    const allowed = response();
    await handleAccessRoute({ access, sessions, can: (id, cap) => access.can(id, cap) }, request("POST", { userId: TARGET, role: "custom", capabilities: ["dashboard", "logs"] }), allowed, new URL("https://dashboard.example/api/access/users/update"), { user: { id: MANAGER, username: "manager" }, guard });
    assert.equal(allowed.status, 200);
    assert.deepEqual(new Set(access.capabilitiesFor(TARGET)), new Set(["dashboard", "logs"]));
  } finally { sessions.close(); }
});

test("user management cannot modify bot owners or the acting user's own permissions", async () => {
  const access = AccessPolicy.inMemory([OWNER]);
  access.setCapabilities(MANAGER, ["dashboard", "logs", "access.manage"]);
  const sessions = new SessionStore({ maxAgeMs: 60_000, sweepMs: 60_000 });
  try {
    for (const userId of [OWNER, MANAGER]) {
      const res = response();
      await handleAccessRoute({ access, sessions, can: (id, cap) => access.can(id, cap) }, request("POST", { userId, role: "user", capabilities: ["dashboard"] }), res, new URL("https://dashboard.example/api/access/users/update"), { user: { id: MANAGER, username: "manager" }, guard });
      assert.equal(res.status, 403);
    }
  } finally { sessions.close(); }
});
