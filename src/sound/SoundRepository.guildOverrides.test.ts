import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoundRepository } from "./SoundRepository.ts";

const G1 = "111111111111111";
const G2 = "333333333333333";
const [A, B, C] = ["222222222222221", "222222222222222", "222222222222223"];

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "soundbot-guild-overrides-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "db.json");
  return { file, repo: new SoundRepository(file, { countPlays: false }) };
}

test("guildEntranceOverrides lists assigned and suppressed members of that guild only, sorted by id", (t) => {
  const { repo } = setup(t);
  repo.setGuildEntrance(G1, C, "gamma");
  repo.setGuildEntrance(G1, A, "alpha");
  repo.clearGuildEntrance(G1, B); // suppression is stored as ""
  repo.setGuildEntrance(G2, A, "other-guild");
  assert.deepEqual(repo.guildEntranceOverrides(G1), [
    { userId: A, sound: "alpha" },
    { userId: B, sound: null },
    { userId: C, sound: "gamma" },
  ]);
  assert.deepEqual(repo.guildEntranceOverrides(G2), [{ userId: A, sound: "other-guild" }]);
  assert.deepEqual(repo.guildEntranceOverrides("999999999999999"), []);
});

test("releaseAllGuildEntrances removes assigned AND suppressed overrides of one guild with a single save", (t) => {
  const { repo, file } = setup(t);
  repo.setEntrance(A, "personal-a");
  repo.setEntrance(B, "personal-b");
  repo.setUserGuildEntrance(A, G1, "my-own-for-g1");
  repo.setGuildEntranceSettings(G1, { enabled: false, maxDurationSec: 7 });
  repo.setGuildEntrance(G1, A, "assigned");
  repo.clearGuildEntrance(G1, B);
  repo.setGuildEntrance(G2, A, "keep-me");

  const flush = t.mock.method(repo, "flush");
  assert.equal(repo.releaseAllGuildEntrances(G1), 2);
  assert.equal(flush.mock.callCount(), 1, "one save for the whole operation, not one per member");

  // released, so the members' own sounds apply again in G1
  assert.deepEqual(repo.guildEntranceOverrides(G1), []);
  assert.equal(repo.hasGuildEntranceOverride(A, G1), false);
  assert.equal(repo.entrance(B, G1), "personal-b"); // was suppressed: not silenced any more
  // everything else is untouched
  assert.equal(repo.entrance(A), "personal-a");
  assert.equal(repo.entrance(B), "personal-b");
  assert.equal(repo.userGuildEntrance(A, G1), "my-own-for-g1");
  assert.deepEqual(repo.guildEntranceSettings(G1), { enabled: false, maxDurationSec: 7 });
  assert.deepEqual(repo.guildEntranceOverrides(G2), [{ userId: A, sound: "keep-me" }]);

  // persisted
  const reread = new SoundRepository(file, { countPlays: false });
  assert.deepEqual(reread.guildEntranceOverrides(G1), []);
  assert.deepEqual(reread.guildEntranceOverrides(G2), [{ userId: A, sound: "keep-me" }]);
  assert.equal(reread.entrance(A), "personal-a");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).guildEntrances[G1], undefined);
});

test("releaseAllGuildEntrances does nothing, and does not save, when there is nothing to release", (t) => {
  const { repo, file } = setup(t);
  repo.setGuildEntrance(G2, A, "keep-me");
  const before = readFileSync(file, "utf8");
  const flush = t.mock.method(repo, "flush");
  assert.equal(repo.releaseAllGuildEntrances(G1), 0);
  assert.equal(flush.mock.callCount(), 0);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("an empty guild map in a hand-edited db.json counts as nothing to release (no save)", (t) => {
  const { file } = setup(t);
  writeFileSync(file, JSON.stringify({ guildEntrances: { [G1]: {} }, entrances: { [A]: "personal" } }));
  const repo = new SoundRepository(file, { countPlays: false });
  const flush = t.mock.method(repo, "flush");
  assert.deepEqual(repo.guildEntranceOverrides(G1), []);
  assert.equal(repo.releaseAllGuildEntrances(G1), 0);
  assert.equal(flush.mock.callCount(), 0);
});

test("releaseGuildEntrance (single) releases instead of suppressing, unlike clearGuildEntrance", (t) => {
  const { repo } = setup(t);
  repo.setEntrance(A, "personal");
  repo.setGuildEntrance(G1, A, "assigned");
  assert.equal(repo.releaseGuildEntrance(G1, A), true);
  assert.equal(repo.entrance(A, G1), "personal");
});
