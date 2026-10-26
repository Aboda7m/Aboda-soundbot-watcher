import test from "node:test";
import assert from "node:assert/strict";
import { planIntros } from "./introRules.ts";

test("guild-specific entrance override is looked up using the voice move's guild", () => {
  const plans = planIntros({
    userId: "222222222222222", isBot: false, guildId: "111111111111111",
    fromChannelId: null, toChannelId: "333333333333333",
  }, {
    entrance: (_userId, guildId) => guildId === "111111111111111" ? "guild-sound" : "personal-sound",
    exit: () => undefined,
    hasSound: () => true,
  });
  assert.deepEqual(plans.map((p) => p.sound), ["guild-sound"]);
});
