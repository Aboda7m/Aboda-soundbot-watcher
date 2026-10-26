import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorizer } from "./authorize.ts";

test("a user sharing a bot guild can sign in without a user-ID allowlist", async () => {
  const authorize = createAuthorizer({
    userIds: [],
    roleIds: [],
    inBotServer: async (userId) => userId === "222222222222222",
    fetchMember: async () => null,
  });
  assert.equal(await authorize("222222222222222"), true);
});

test("a user with no shared guild and no other grant is denied", async () => {
  const authorize = createAuthorizer({
    userIds: [],
    roleIds: [],
    inBotServer: async () => false,
    fetchMember: async () => null,
  });
  assert.equal(await authorize("333333333333333"), false);
});

test("an indeterminate Discord membership lookup does not grant login", async () => {
  const authorize = createAuthorizer({
    userIds: [],
    roleIds: [],
    inBotServer: async () => { throw new Error("Discord unavailable"); },
    fetchMember: async () => null,
  });
  assert.equal(await authorize("333333333333333"), false);
});
