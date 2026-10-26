import test from "node:test";
import assert from "node:assert/strict";
import { mayAdministerGuild } from "./entranceAdminAuth.ts";

test("guild owner may administer entrance sounds without explicit permission flags", () => {
  assert.equal(mayAdministerGuild("111111111111111", "111111111111111", {
    hasAdministrator: false, hasManageGuild: false,
  }), true);
});

test("Manage Server grants administration only for the target guild membership check", () => {
  assert.equal(mayAdministerGuild("222222222222222", "111111111111111", {
    hasAdministrator: false, hasManageGuild: true,
  }), true);
});

test("Administrator grants administration", () => {
  assert.equal(mayAdministerGuild("222222222222222", "111111111111111", {
    hasAdministrator: true, hasManageGuild: false,
  }), true);
});

test("ordinary guild member is not an administrator", () => {
  assert.equal(mayAdministerGuild("222222222222222", "111111111111111", {
    hasAdministrator: false, hasManageGuild: false,
  }), false);
});
