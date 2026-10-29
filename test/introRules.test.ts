import { test } from "node:test";
import assert from "node:assert/strict";
import { createCooldown, planIntros, shouldPlayEntrance, type VoiceMove } from "../src/sound/introRules.ts";

const lookup = {
  entrance: (id: string) => ({ u1: "hello", u2: "missing" })[id],
  exit: (id: string) => ({ u1: "bye" })[id],
  hasSound: (n: string) => n !== "missing",
};
const move = (o: Partial<VoiceMove>): VoiceMove => ({
  userId: "u1", isBot: false, guildId: "g", fromChannelId: null, toChannelId: null, ...o,
});

test("join plays entrance in the new channel", () => {
  assert.deepEqual(planIntros(move({ toChannelId: "c1" }), lookup), [
    { kind: "entrance", sound: "hello", guildId: "g", channelId: "c1" },
  ]);
});
test("leave plays exit in the old channel", () => {
  assert.deepEqual(planIntros(move({ fromChannelId: "c1" }), lookup), [
    { kind: "exit", sound: "bye", guildId: "g", channelId: "c1" },
  ]);
});
test("moving between channels plays exit only, not entrance", () => {
  const plans = planIntros(move({ fromChannelId: "c1", toChannelId: "c2" }), lookup);
  assert.deepEqual(plans.map((p) => [p.kind, p.channelId]), [["exit", "c1"]]);
});
test("mute/deafen (same channel), bots, unknown users and missing files do nothing", () => {
  assert.deepEqual(planIntros(move({ fromChannelId: "c1", toChannelId: "c1" }), lookup), []);
  assert.deepEqual(planIntros(move({ toChannelId: "c1", isBot: true }), lookup), []);
  assert.deepEqual(planIntros(move({ userId: "nobody", toChannelId: "c1" }), lookup), []);
  assert.deepEqual(planIntros(move({ userId: "u2", toChannelId: "c1" }), lookup), []);
});
test("cooldown blocks repeats inside the window only", () => {
  let t = 1000;
  const ok = createCooldown(3000, () => t);
  assert.equal(ok("a"), true);
  assert.equal(ok("a"), false);
  assert.equal(ok("b"), true);
  t += 3000;
  assert.equal(ok("a"), true);
});

test("entrance sound is only eligible when joining from outside voice", () => {
  assert.equal(shouldPlayEntrance(move({ toChannelId: "c1" })), true);
  assert.equal(shouldPlayEntrance(move({ fromChannelId: "c1", toChannelId: "c2" })), false);
  assert.equal(shouldPlayEntrance(move({ fromChannelId: "c1" })), false);
  assert.equal(shouldPlayEntrance(move({ fromChannelId: null, toChannelId: null })), false);
});
