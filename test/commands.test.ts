import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEntrance, handleSoundList, type CommandMessage } from "../src/discord/textCommands.ts";
import { parseEntranceCommand } from "../src/discord/textCommand.ts";
import { SoundRepository } from "../src/sound/SoundRepository.ts";
import type { SoundLibrary } from "../src/sound/SoundLibrary.ts";

const lib = (names: string[]) => ({ list: () => names, has: (n: string) => names.includes(n) }) as unknown as SoundLibrary;

function fakeMessage(opts: { dmFails?: boolean } = {}) {
  const dms: string[] = [];
  const replies: string[] = [];
  const msg: CommandMessage = {
    author: {
      id: "u1",
      send: async (c) => {
        if (opts.dmFails) throw new Error("Cannot send messages to this user");
        dms.push(c);
      },
    },
    reply: async (o) => {
      replies.push(typeof o === "string" ? o : o.content);
    },
  };
  return { msg, dms, replies };
}

test("!soundlist DMs sorted names, in chunks under 2000 chars, sourced from the library", async () => {
  const names = Array.from({ length: 400 }, (_, i) => `sound ${String(i).padStart(3, "0")} with a long-ish name`).reverse();
  const { msg, dms, replies } = fakeMessage();
  await handleSoundList(msg, lib(names));
  assert.ok(dms.length > 1);
  for (const d of dms) assert.ok(d.length < 2000);
  const listed = dms.join("\n").split("\n").filter((l) => l.startsWith("• ")).map((l) => l.slice(2));
  assert.equal(listed.length, 400);
  assert.deepEqual(listed, [...listed].sort((a, b) => a.localeCompare(b)));
  assert.match(replies[0]!, /Sent you a DM/);
});

test("!soundlist with an empty library sends no DM", async () => {
  const { msg, dms, replies } = fakeMessage();
  await handleSoundList(msg, lib([]));
  assert.equal(dms.length, 0);
  assert.match(replies[0]!, /no sounds/i);
});

test("!soundlist when DMs are closed replies gracefully instead of throwing", async () => {
  const { msg, dms, replies } = fakeMessage({ dmFails: true });
  await assert.doesNotReject(handleSoundList(msg, lib(["a", "b"])));
  assert.equal(dms.length, 0);
  assert.match(replies[0]!, /couldn't DM/);
});

function setup(names = ["airhorn", "air horn 2", "vine boom"]) {
  const p = join(mkdtempSync(join(tmpdir(), "cmd-")), "db.json");
  writeFileSync(p, JSON.stringify({ entrances: {}, exits: {}, ignoreList: [], sounds: [] }));
  const repo = new SoundRepository(p, { countPlays: false });
  const run = async (text: string, m = fakeMessage()) => {
    await handleEntrance(m.msg, parseEntranceCommand(text)!, { library: lib(names), repo, prefix: "!" });
    return m.replies[0]!;
  };
  return { repo, run };
}

test("!entrance shows, sets, replaces and clears the caller's own entrance", async () => {
  const { repo, run } = setup();
  assert.match(await run("!entrance"), /no entrance sound/);
  assert.match(await run("!entrance vine boom"), /now \*\*vine boom\*\*/);
  assert.equal(repo.entrance("u1"), "vine boom");
  assert.match(await run("!entrance"), /\*\*vine boom\*\*/);
  assert.match(await run("!entrance AIRHORN"), /now \*\*airhorn\*\*/); // case-insensitive -> canonical name stored
  assert.equal(repo.entrance("u1"), "airhorn");
  // Every clear is now answered with the same message (it no longer says whether anything was set);
  // the behaviour under test is that the assignment is gone.
  assert.match(await run("!entrance !clear"), /^Cleared your entrance sound\.$/);
  assert.equal(repo.entrance("u1"), undefined);
  assert.match(await run("!RM-entrance"), /^Cleared your entrance sound\.$/);
});

test("!entrance rejects unknown names with suggestions and does not save", async () => {
  const { repo, run } = setup();
  assert.match(await run("!entrance nothing"), /No sound called "nothing"/);
  const r = await run("!entrance horn"); // partial: suggest, never silently set
  assert.match(r, /Did you mean/);
  assert.match(r, /airhorn/);
  assert.equal(repo.entrance("u1"), undefined);
});

// Targeting another member is now allowed for Manage Server / Administrator (see test/textCommandDispatch.test.ts);
// a caller without that permission (the fake message has no member) must still be refused and change nothing.
test("!entrance refuses to target another member without Manage Server or Administrator", async () => {
  const { repo, run } = setup();
  assert.match(await run("!entrance <@999>"), /Manage Server or Administrator permission/);
  assert.equal(repo.entrance("999"), undefined);
  assert.equal(repo.entrance("u1"), undefined);
});

test("!entrance without a repository degrades gracefully", async () => {
  const m = fakeMessage();
  await handleEntrance(m.msg, { kind: "entrance-show" }, { library: lib([]), prefix: "!" });
  assert.match(m.replies[0]!, /not available/);
});
