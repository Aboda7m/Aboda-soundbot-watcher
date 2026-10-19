import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
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
