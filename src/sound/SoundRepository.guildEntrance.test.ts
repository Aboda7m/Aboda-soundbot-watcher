import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoundRepository } from "./SoundRepository.ts";

test("guild entrance overrides are isolated and clearing suppresses personal fallback only in that guild", () => {
  const dir = mkdtempSync(join(tmpdir(), "soundbot-guild-entrance-"));
  const file = join(dir, "db.json");
  try {
    const repo = new SoundRepository(file, { countPlays: false });
    repo.setEntrance("222222222222222", "personal");
    repo.setGuildEntrance("111111111111111", "222222222222222", "guild-a");
    assert.equal(repo.entrance("222222222222222"), "personal");
    assert.equal(repo.entrance("222222222222222", "111111111111111"), "guild-a");
    assert.equal(repo.entrance("222222222222222", "333333333333333"), "personal");
    repo.clearGuildEntrance("111111111111111", "222222222222222");
    assert.equal(repo.entrance("222222222222222", "111111111111111"), undefined);
    assert.equal(repo.entrance("222222222222222", "333333333333333"), "personal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bot-admin duration caps are independent and removable without changing personal or guild settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "soundbot-entrance-cap-"));
  const file = join(dir, "db.json");
  try {
    const repo = new SoundRepository(file, { countPlays: false });
    const user = "222222222222222";
    repo.setUserEntranceDuration(user, 10);
    repo.setUserEntranceDuration(user, 8, "111111111111111");
    assert.equal(repo.userGuildEntranceDuration(user, "111111111111111"), 8);
    repo.setUserEntranceDuration(user, null, "111111111111111");
    assert.equal(repo.userGuildEntranceDuration(user, "111111111111111"), undefined);
    repo.setGuildEntranceSettings("111111111111111", { maxDurationSec: 5 });
    repo.setBotEntranceDurationCap(user, 3);
    assert.equal(repo.userEntranceDuration(user), 10);
    assert.equal(repo.guildEntranceSettings("111111111111111").maxDurationSec, 5);
    assert.equal(repo.botEntranceDurationCap(user), 3);
    repo.setBotEntranceDurationCap(user, null);
    assert.equal(repo.botEntranceDurationCap(user), undefined);
    assert.equal(repo.userEntranceDuration(user), 10);
    assert.equal(repo.guildEntranceSettings("111111111111111").maxDurationSec, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
