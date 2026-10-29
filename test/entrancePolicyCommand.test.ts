import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEntrancePolicyCommand, handleEntrancePolicy } from "../src/discord/commands/entrance-policy.command.ts";
import { SoundRepository } from "../src/sound/SoundRepository.ts";
import type { CommandMessage } from "../src/discord/commandTypes.ts";

function makeMessage(options: { admin?: boolean; manageGuild?: boolean } = {}) {
  const replies: string[] = [];
  const message: CommandMessage = {
    author: { id: "user-1", send: async () => undefined },
    member: { permissions: { has: (flag: bigint) => flag === 8n ? Boolean(options.admin) : flag === 32n ? Boolean(options.manageGuild) : false } },
    reply: async (value) => { replies.push(typeof value === "string" ? value : value.content); return undefined; },
  };
  return { message, replies };
}

function repo() {
  return new SoundRepository(join(mkdtempSync(join(tmpdir(), "entrance-policy-command-")), "db.json"), { countPlays: false });
}

test("entrance policy parser accepts display and supported settings", () => {
  assert.deepEqual(parseEntrancePolicyCommand("!entrance-policy"), { kind: "show" });
  assert.deepEqual(parseEntrancePolicyCommand("!entrance-policy status"), { kind: "show" });
  assert.deepEqual(parseEntrancePolicyCommand("!entrance-policy enabled off"), { kind: "enabled", value: false });
  assert.deepEqual(parseEntrancePolicyCommand("!entrance-policy reconnect 15m"), { kind: "reconnect", seconds: 900 });
  assert.deepEqual(parseEntrancePolicyCommand("!entrance-policy reconnect off"), { kind: "reconnect", seconds: 0 });
  assert.deepEqual(parseEntrancePolicyCommand("!entrance-policy cooldown 5m"), { kind: "cooldown", seconds: 300 });
  assert.deepEqual(parseEntrancePolicyCommand("!entrance-policy cooldown off"), { kind: "cooldown", seconds: 0 });
  assert.deepEqual(parseEntrancePolicyCommand("!entrance-policy cap 12"), { kind: "cap", seconds: 12 });
  assert.deepEqual(parseEntrancePolicyCommand("!entrance-policy cap off"), { kind: "cap", seconds: null });
  assert.equal(parseEntrancePolicyCommand("!entrance-policy cap 31"), null);
  assert.equal(parseEntrancePolicyCommand("!entrance-policy reconnect nonsense"), null);
  assert.equal(parseEntrancePolicyCommand("!entrance-policy-extra"), null);
});

test("only server admins or explicitly granted bot managers can change entrance policy", async () => {
  const r = repo();
  const denied = makeMessage();
  await handleEntrancePolicy(denied.message, "guild-1", { kind: "reconnect", seconds: 900 }, {
    repo: r, prefix: "!", access: { can: () => false },
  });
  assert.match(denied.replies[0]!, /Only this server/);
  assert.deepEqual(r.guildEntranceSettings("guild-1"), {});

  const admin = makeMessage({ manageGuild: true });
  await handleEntrancePolicy(admin.message, "guild-1", { kind: "reconnect", seconds: 900 }, {
    repo: r, prefix: "!", access: { can: () => false },
  });
  assert.equal(r.guildEntranceSettings("guild-1").reconnectGraceSec, 900);
  assert.equal(r.guildEntranceSettings("guild-1").minReconnectGraceSec, 900);
  assert.match(admin.replies[0]!, /15m/);
});

test("policy command writes independent guild settings for enable, cooldown and duration cap", async () => {
  const r = repo();
  const { message, replies } = makeMessage({ admin: true });
  const deps = { repo: r, prefix: "!", access: { can: () => false } };
  await handleEntrancePolicy(message, "guild-2", { kind: "enabled", value: false }, deps);
  await handleEntrancePolicy(message, "guild-2", { kind: "cooldown", seconds: 0 }, deps);
  await handleEntrancePolicy(message, "guild-2", { kind: "cap", seconds: 10 }, deps);
  const policy = r.guildEntranceSettings("guild-2");
  assert.equal(policy.enabled, false);
  assert.equal(policy.userCooldownSec, 0);
  assert.equal(policy.enforcedUserCooldownSec, 0);
  assert.equal(policy.allowUserCooldown, false);
  assert.equal(policy.maxDurationSec, 10);
  assert.equal(replies.length, 3);
});
