import test from "node:test";
import assert from "node:assert/strict";
import { AccessPolicy, ADMIN_CAPABILITIES, CAPABILITIES } from "./AccessPolicy.ts";

const OWNER = "111111111111111";
const USER = "222222222222222";

test("Bot Admin preset contains all operational capabilities but not user-management permission", () => {
  assert.deepEqual(ADMIN_CAPABILITIES, ["dashboard", "import", "entrance.manage", "entrance.system", "logs"]);
  assert.ok(CAPABILITIES.includes("access.manage"));
  assert.ok(!ADMIN_CAPABILITIES.includes("access.manage" as never));
});

test("owner can replace a user's grants with custom capabilities and remove them", () => {
  const access = AccessPolicy.inMemory([OWNER]);
  access.setCapabilities(USER, ["dashboard", "logs", "access.manage"]);
  assert.deepEqual(new Set(access.capabilitiesFor(USER)), new Set(["dashboard", "logs", "access.manage"]));
  access.setCapabilities(USER, []);
  assert.deepEqual(access.capabilitiesFor(USER), []);
});

test("bot owners remain owners and cannot be demoted by stored capability changes", () => {
  const access = AccessPolicy.inMemory([OWNER]);
  access.setCapabilities(OWNER, []);
  assert.equal(access.isOwner(OWNER), true);
  assert.equal(access.can(OWNER, "access.manage"), true);
  assert.deepEqual(new Set(access.capabilitiesFor(OWNER)), new Set(CAPABILITIES));
});
