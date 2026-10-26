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
