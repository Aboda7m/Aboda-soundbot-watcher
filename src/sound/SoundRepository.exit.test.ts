import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoundRepository } from "./SoundRepository.ts";

const fresh = (initial?: object) => {
  const path = join(mkdtempSync(join(tmpdir(), "exit-repo-")), "db.json");
  if (initial) writeFileSync(path, JSON.stringify(initial));
  return { path, repo: new SoundRepository(path, { countPlays: false }) };
};

test("setExit stores the sound and persists it to db.json", () => {
  const { path, repo } = fresh();
  repo.setExit("u1", "airhorn");
  assert.equal(repo.exit("u1"), "airhorn");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).exits.u1, "airhorn");
});

test("setExit does not touch entrances or other users' exits", () => {
  const { repo } = fresh({ entrances: { u1: "intro" }, exits: { u2: "bye" } });
  repo.setExit("u1", "airhorn");
  assert.equal(repo.entrance("u1"), "intro");
  assert.equal(repo.exit("u2"), "bye");
});

test("clearExit removes the sound and reports whether one existed", () => {
  const { path, repo } = fresh({ exits: { u1: "airhorn" } });
  assert.equal(repo.clearExit("u1"), true);
  assert.equal(repo.exit("u1"), undefined);
  assert.equal("u1" in JSON.parse(readFileSync(path, "utf8")).exits, false);
  assert.equal(repo.clearExit("u1"), false);
});

test("clearExit leaves the entrance sound alone", () => {
  const { repo } = fresh({ entrances: { u1: "intro" }, exits: { u1: "bye" } });
  repo.clearExit("u1");
  assert.equal(repo.entrance("u1"), "intro");
});
