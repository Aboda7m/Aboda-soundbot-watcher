import test from "node:test";
import assert from "node:assert/strict";
import { resolveAutomaticEntrance } from "./entranceResolver.ts";

test("missing guild preference inherits global; custom and disabled are explicit", () => {
  assert.equal(resolveAutomaticEntrance({ globalPreference: "A" }).sound, "A");
  assert.equal(resolveAutomaticEntrance({ globalPreference: "A", userGuildPreference: "B" }).sound, "B");
  assert.deepEqual(resolveAutomaticEntrance({ globalPreference: "A", userGuildPreference: "" }), { allowed: false, sound: null, reason: "user-guild-disabled" });
});
test("guild disable and admin assignment/suppression have correct precedence", () => {
  assert.equal(resolveAutomaticEntrance({ guildEnabled: false, adminAssignment: "B", globalPreference: "A" }).reason, "guild-disabled");
  assert.equal(resolveAutomaticEntrance({ adminAssignment: "B", userGuildPreference: "C", globalPreference: "A" }).sound, "B");
  assert.equal(resolveAutomaticEntrance({ adminAssignment: "", globalPreference: "A" }).reason, "admin-suppressed");
});
test("all applicable duration caps are minimized; null and missing are not zero", () => {
  assert.equal(resolveAutomaticEntrance({ globalPreference: "A", personalDurationSec: 10, guildDurationSec: 5, botAdminDurationSec: 3 }).maxDurationSec, 3);
  assert.equal(resolveAutomaticEntrance({ globalPreference: "A", personalDurationSec: null, guildDurationSec: null }).maxDurationSec, undefined);
});
