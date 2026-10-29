import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoundRepository } from "../src/sound/SoundRepository.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "db-")), "db.json");
const legacy = {
  entrances: { "111": "airhorn" },
  exits: { "222": "bye" },
  ignoreList: ["333"],
  sounds: [{ name: "airhorn", count: 5, tags: ["loud"] }],
  customKey: { keep: "me" },
};

test("reads the legacy schema", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify(legacy));
  const r = new SoundRepository(p, { countPlays: true });
  assert.equal(r.entrance("111"), "airhorn");
  assert.equal(r.exit("222"), "bye");
  assert.equal(r.entrance("999"), undefined);
  assert.deepEqual(r.sounds(), legacy.sounds);
});

test("recordPlay writes atomically, keeps unknown keys, backs up the original once", () => {
  const p = tmp();
  const original = JSON.stringify(legacy, null, 2);
  writeFileSync(p, original);
  const r = new SoundRepository(p, { countPlays: true });
  r.recordPlay("airhorn");
  r.recordPlay("newsound");
  r.flush();
  const saved = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(saved.sounds[0].count, 6);
  assert.deepEqual(saved.sounds[1], { name: "newsound", count: 1, tags: [] });
  assert.deepEqual(saved.customKey, { keep: "me" });
  assert.deepEqual(saved.entrances, legacy.entrances);
  assert.equal(readFileSync(`${p}.bak`, "utf8"), original);
  assert.equal(existsSync(`${p}.tmp`), false);
  r.recordPlay("airhorn");
  r.flush();
  assert.equal(readFileSync(`${p}.bak`, "utf8"), original); // backup is not overwritten
});

test("never touches the file when nothing changed or counting is off", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify(legacy));
  const before = readFileSync(p, "utf8");
  const r = new SoundRepository(p, { countPlays: false });
  r.recordPlay("airhorn");
  r.flush();
  assert.equal(readFileSync(p, "utf8"), before);
  assert.equal(existsSync(`${p}.bak`), false);
});

test("malformed or wrongly shaped files are refused, not overwritten", () => {
  const p = tmp();
  writeFileSync(p, "{ not json");
  assert.throws(() => new SoundRepository(p, { countPlays: true }));
  writeFileSync(p, JSON.stringify({ entrances: [1, 2] }));
  assert.throws(() => new SoundRepository(p, { countPlays: true }), /entrances/);
  assert.equal(readFileSync(p, "utf8"), JSON.stringify({ entrances: [1, 2] }));
});

test("missing or empty file starts empty and is only created on first write", () => {
  const p = tmp();
  const r = new SoundRepository(p, { countPlays: true });
  assert.equal(r.entrance("1"), undefined);
  assert.equal(existsSync(p), false);
  r.recordPlay("a");
  r.flush();
  assert.equal(JSON.parse(readFileSync(p, "utf8")).sounds[0].count, 1);
  writeFileSync(p, "");
  assert.doesNotThrow(() => new SoundRepository(p, { countPlays: true }));
});

test("external edits to db.json are picked up while running", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify(legacy));
  const r = new SoundRepository(p, { countPlays: true });
  assert.equal(r.entrance("111"), "airhorn");
  writeFileSync(p, JSON.stringify({ ...legacy, entrances: { "111": "other" } }));
  const t = new Date(Date.now() + 5000);
  utimesSync(p, t, t);
  assert.equal(r.entrance("111"), "other");
});

test("setEntrance / clearEntrance persist immediately and keep everything else", () => {
  const p = tmp();
  const original = JSON.stringify(legacy, null, 2);
  writeFileSync(p, original);
  const r = new SoundRepository(p, { countPlays: true });
  r.setEntrance("444", "newsound");
  r.setEntrance("111", "changed");
  let saved = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(saved.entrances, { "111": "changed", "444": "newsound" });
  assert.deepEqual(saved.exits, legacy.exits);
  assert.deepEqual(saved.sounds, legacy.sounds);
  assert.deepEqual(saved.customKey, { keep: "me" });
  assert.equal(readFileSync(`${p}.bak`, "utf8"), original);
  assert.equal(existsSync(`${p}.tmp`), false);
  assert.equal(r.entrance("444"), "newsound");

  assert.equal(r.clearEntrance("444"), true);
  assert.equal(r.clearEntrance("444"), false);
  assert.equal(r.clearEntrance("nobody"), false);
  saved = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(saved.entrances, { "111": "changed" });
  assert.equal(r.entrance("444"), undefined);
  // a fresh instance (restart) sees the same data
  assert.equal(new SoundRepository(p, { countPlays: true }).entrance("111"), "changed");
});

test("setEntrance creates db.json when missing; clearing a missing entry writes nothing", () => {
  const p = tmp();
  const r = new SoundRepository(p, { countPlays: true });
  assert.equal(r.clearEntrance("1"), false);
  assert.equal(existsSync(p), false);
  r.setEntrance("1", "a");
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).entrances, { "1": "a" });
});

test("entrance policy settings preserve legacy admin suppression and release restores fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "soundbot-policy-"));
  const file = join(dir, "db.json");
  try {
    const repo = new SoundRepository(file, { countPlays: false });
    repo.setEntrance("222222222222222", "global");
    repo.setGuildEntrance("111111111111111", "222222222222222", "");
    repo.setUserGuildEntrance("222222222222222", "111111111111111", "personal-guild");
    assert.equal(repo.guildEntranceAssignment("222222222222222", "111111111111111"), "");
    assert.equal(repo.userGuildEntrance("222222222222222", "111111111111111"), "personal-guild");
    assert.equal(repo.releaseGuildEntrance("111111111111111", "222222222222222"), true);
    assert.equal(repo.guildEntranceAssignment("222222222222222", "111111111111111"), undefined);
    repo.setUserEntranceDuration("222222222222222", 12);
    repo.setUserEntranceDuration("222222222222222", 8, "111111111111111");
    repo.setUserEntranceTiming("222222222222222", { cooldownSec: 420, reconnectGraceSec: 1200 });
    repo.setGuildEntranceSettings("111111111111111", { enabled: false, maxDurationSec: 10, guildCooldownSec: 0 });
    assert.equal(repo.userEntranceDuration("222222222222222"), 12);
    assert.equal(repo.userEntranceDuration("222222222222222", "111111111111111"), 8);
    assert.equal(repo.userEntranceTiming("222222222222222").cooldownSec, 420);
    assert.equal(repo.guildEntranceSettings("111111111111111").enabled, false);
    const reloaded = new SoundRepository(file, { countPlays: false });
    assert.equal(reloaded.userGuildEntrance("222222222222222", "111111111111111"), "personal-guild");
    assert.equal(reloaded.guildEntranceAssignment("222222222222222", "111111111111111"), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid duration caps are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "soundbot-policy-invalid-"));
  try {
    const repo = new SoundRepository(join(dir, "db.json"), { countPlays: false });
    assert.throws(() => repo.setUserEntranceDuration("222222222222222", 31), /Duration/);
    assert.throws(() => repo.setGuildEntranceSettings("111111111111111", { maxDurationSec: 0 }), /maxDurationSec/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
