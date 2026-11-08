import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessPolicy } from "../access/AccessPolicy.ts";
import { SoundRepository } from "../sound/SoundRepository.ts";
import { loadCommands } from "./commandRegistry.ts";
import type { CommandDeps, IncomingMessage } from "./commandTypes.ts";
import { parseGuildEntranceCommand } from "./commands/guild-entrance.command.ts";
import { handleTextMessage } from "./textCommands.ts";

const OWNER = "100000000000000001";
const ENTRANCE_MANAGER = "100000000000000002"; // bot grant: entrance.manage
const DISCORD_ADMIN = "100000000000000003"; // Discord Administrator
const SERVER_MANAGER = "100000000000000004"; // Discord Manage Server
const CHANNEL_MANAGER = "100000000000000005"; // Manage Channels + Move Members only: NOT enough here
const IMPORTER = "100000000000000006"; // a different bot grant
const REGULAR = "100000000000000007";
const T1 = "300000000000000001"; // members the overrides are about
const T2 = "300000000000000002";
const T3 = "300000000000000003";
const GUILD = "200000000000000001";
const OTHER = "200000000000000002";

const PERMS: Record<string, bigint[]> = {
  [DISCORD_ADMIN]: [1n << 3n],
  [SERVER_MANAGER]: [1n << 5n],
  [CHANNEL_MANAGER]: [1n << 4n, 1n << 24n],
};

const registry = await loadCommands(); // the real commands folder, so help integration is tested for real

function setup(t: TestContext, extra: { noRepo?: boolean; sounds?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "soundbot-guild-cmd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = new SoundRepository(join(dir, "db.json"), { countPlays: false });
  const access = AccessPolicy.inMemory([OWNER]);
  access.grant(ENTRANCE_MANAGER, "entrance.manage");
  access.grant(IMPORTER, "import");
  const sounds = new Set(extra.sounds ?? ["alpha", "beta", "personal-1", "personal-2"]);
  const deps = {
    library: { has: (n: string) => sounds.has(n), list: () => [...sounds] },
    queue: {},
    prefix: "!",
    importer: {},
    repo: extra.noRepo ? undefined : repo,
    access,
    voiceHub: { describe: () => [] },
    followRecorder: {},
    streamManager: {},
  } as unknown as CommandDeps;
  return { repo, deps, access };
}

function fakeMessage(content: string, userId: string, replies: string[]): IncomingMessage {
  const held = PERMS[userId] ?? [];
  return {
    content,
    author: { id: userId, bot: false, tag: "t#0", send: async () => {} },
    guild: { id: GUILD },
    member: { id: userId, permissions: { has: (b: bigint) => held.includes(b) }, voice: { channelId: null } },
    reply: async (o: string | { content: string }) => void replies.push(typeof o === "string" ? o : o.content),
    react: async () => {},
  } as unknown as IncomingMessage;
}

async function send(deps: CommandDeps, content: string, userId: string): Promise<string[]> {
  const replies: string[] = [];
  await handleTextMessage(fakeMessage(content, userId, replies), registry, deps);
  return replies;
}

/** A server with one assigned, one suppressed override, a personal sound for each member, and a second server. */
function populate(repo: SoundRepository) {
  repo.setEntrance(T1, "personal-1");
  repo.setEntrance(T2, "personal-2");
  repo.setUserGuildEntrance(T1, GUILD, "beta"); // T1's own setting for this server
  repo.setGuildEntranceSettings(GUILD, { enabled: true, maxDurationSec: 9 });
  repo.setGuildEntrance(GUILD, T1, "alpha"); // assigned
  repo.clearGuildEntrance(GUILD, T2); // suppressed
  repo.setGuildEntrance(OTHER, T1, "other-server");
  repo.clearGuildEntrance(OTHER, T3);
}

function snapshotOutsideOverrides(repo: SoundRepository) {
  return {
    personal: [repo.entrance(T1), repo.entrance(T2), repo.entrance(T3)],
    ownPref: repo.userGuildEntrance(T1, GUILD),
    policy: repo.guildEntranceSettings(GUILD),
    other: repo.guildEntranceOverrides(OTHER),
  };
}

// ------------------------------------------------------------------ parsing

test("parseGuildEntranceCommand", () => {
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance"), { kind: "help" });
  assert.deepEqual(parseGuildEntranceCommand("!GUILD-ENTRANCE   "), { kind: "help" });
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance list"), { kind: "list" });
  assert.deepEqual(parseGuildEntranceCommand(`!guild-entrance clear <@${T1}>`), { kind: "clear", userId: T1 });
  assert.deepEqual(parseGuildEntranceCommand(`!guild-entrance clear <@!${T1}>`), { kind: "clear", userId: T1 });
  assert.deepEqual(parseGuildEntranceCommand(`!guild-entrance Clear ${T1}`), { kind: "clear", userId: T1 });
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance clear"), { kind: "usage", sub: "clear" });
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance clear nobody"), { kind: "usage", sub: "clear" });
  assert.deepEqual(parseGuildEntranceCommand(`!guild-entrance clear ${T1} ${T2}`), { kind: "usage", sub: "clear" });
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance clear-all"), { kind: "clear-all", confirm: false });
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance clear-all confirm"), { kind: "clear-all", confirm: true });
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance CLEAR-ALL CONFIRM"), { kind: "clear-all", confirm: true });
  // only the exact word confirms; anything else is a usage error and can never delete
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance clear-all yes"), { kind: "usage", sub: "clear-all" });
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance clear-all confirm now"), { kind: "usage", sub: "clear-all" });
  assert.deepEqual(parseGuildEntranceCommand("!guild-entrance nonsense"), { kind: "usage", sub: "" });
  assert.deepEqual(parseGuildEntranceCommand("?guild-entrance list", "?"), { kind: "list" });
  assert.equal(parseGuildEntranceCommand("!guild-entrances"), null);
  assert.equal(parseGuildEntranceCommand("!entrance-policy"), null);
  assert.equal(parseGuildEntranceCommand("!entrance"), null);
});

test("the command registers cleanly next to the existing ones (no name clash)", () => {
  assert.ok(registry.lookup("guild-entrance"));
  const names = registry.commands.flatMap((c) => c.command.names);
  assert.equal(new Set(names).size, names.length);
});

// ------------------------------------------------------------------ permissions

const COMMANDS = [
  "!guild-entrance",
  "!guild-entrance list",
  `!guild-entrance clear ${T1}`,
  "!guild-entrance clear-all",
  "!guild-entrance clear-all confirm",
];

test("people without access get NO reply and change nothing, for every subcommand", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo);
  const before = JSON.stringify([repo.guildEntranceOverrides(GUILD), snapshotOutsideOverrides(repo)]);
  for (const who of [REGULAR, IMPORTER, CHANNEL_MANAGER]) {
    for (const c of COMMANDS) assert.deepEqual(await send(deps, c, who), [], `${who}: ${c}`);
  }
  assert.equal(JSON.stringify([repo.guildEntranceOverrides(GUILD), snapshotOutsideOverrides(repo)]), before);
});

test("bot owner, entrance.manage, Discord Administrator and Manage Server are all allowed", async (t) => {
  for (const who of [OWNER, ENTRANCE_MANAGER, DISCORD_ADMIN, SERVER_MANAGER]) {
    const { repo, deps } = setup(t);
    populate(repo);
    assert.match((await send(deps, "!guild-entrance list", who)).join("\n"), /2 \(1 assigned, 1 suppressed\)/, who);
    assert.match((await send(deps, `!guild-entrance clear ${T1}`, who)).join("\n"), /Released the guild override/, who);
    assert.match((await send(deps, "!guild-entrance clear-all confirm", who)).join("\n"), /Removed \*\*1\*\*/, who);
  }
});

test("a blocked bot user is ignored by the dispatcher as for every command", async (t) => {
  const { deps, access } = setup(t);
  access.setWhitelist(true); // nobody but owners may use the bot
  assert.deepEqual(await send(deps, "!guild-entrance list", DISCORD_ADMIN), []);
  assert.ok((await send(deps, "!guild-entrance list", OWNER)).length > 0);
});

test("when the repository is unavailable, authorized people are told and others still get silence", async (t) => {
  const { deps } = setup(t, { noRepo: true });
  assert.deepEqual(await send(deps, "!guild-entrance list", REGULAR), []);
  assert.deepEqual(await send(deps, "!guild-entrance list", OWNER), ["Entrance settings are unavailable right now."]);
});

// ------------------------------------------------------------------ explanation

test("!guild-entrance explains overrides, the priority order, and why a personal sound may not play", async (t) => {
  const { deps } = setup(t);
  const text = (await send(deps, "!guild-entrance", DISCORD_ADMIN)).join("\n");
  assert.match(text, /assigned/);
  assert.match(text, /suppressed/);
  assert.match(text, /Why a personal entrance sound may not play/);
  assert.match(text, /wins over the member's own sounds/);
  assert.match(text, /`!guild-entrance clear-all confirm`/);
  assert.match(text, /never changed/);
});

test("usage errors explain the right form and delete nothing", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo);
  assert.match((await send(deps, "!guild-entrance clear", OWNER)).join(""), /Usage: `!guild-entrance clear <@user\|id>`/);
  assert.match((await send(deps, "!guild-entrance clear-all yes", OWNER)).join(""), /clear-all confirm/);
  assert.match((await send(deps, "!guild-entrance bogus", OWNER)).join(""), /list`, `clear @user`, `clear-all/);
  assert.equal(repo.guildEntranceOverrides(GUILD).length, 2);
});

// ------------------------------------------------------------------ list

test("list shows id, kind and sound for assigned and suppressed overrides, only for this server", async (t) => {
  const { repo, deps } = setup(t, { sounds: ["alpha"] });
  populate(repo);
  repo.setGuildEntrance(GUILD, T3, "gone-sound"); // assigned, but no longer in the library
  const text = (await send(deps, "!guild-entrance list", OWNER)).join("\n");
  assert.match(text, /3 \(2 assigned, 1 suppressed\)/);
  assert.ok(text.includes(`<@${T1}> (${T1}) - assigned **alpha**`));
  assert.ok(text.includes(`<@${T2}> (${T2}) - suppressed (no entrance sound plays here)`));
  assert.match(text, new RegExp(`${T3}\\) - assigned \\*\\*gone-sound\\*\\* \\(that sound no longer exists`));
  assert.doesNotMatch(text, /other-server/); // the other server's overrides are not listed
});

test("list on a server without overrides says so", async (t) => {
  const { deps } = setup(t);
  assert.match((await send(deps, "!guild-entrance list", OWNER)).join(""), /No guild entrance overrides in this server/);
});

test("a very long list is capped, split under Discord's limit, and says how many are left", async (t) => {
  const { repo, deps } = setup(t);
  for (let i = 0; i < 80; i++) repo.setGuildEntrance(GUILD, String(400000000000000000n + BigInt(i)), `sound-${i}`);
  const replies = await send(deps, "!guild-entrance list", OWNER);
  assert.ok(replies.every((r) => r.length <= 1900));
  const text = replies.join("\n");
  assert.match(text, /80 \(80 assigned, 0 suppressed\)/);
  assert.match(text, /\.\.\.and 30 more/);
  assert.equal((text.match(/ - assigned /g) ?? []).length, 50);
});

// ------------------------------------------------------------------ clear @user

test("clear releases an ASSIGNED override: the member's own sound applies again, nothing else changes", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo);
  const outside = snapshotOutsideOverrides(repo);
  const text = (await send(deps, `!guild-entrance clear <@${T1}>`, DISCORD_ADMIN)).join("\n");
  assert.match(text, /Released the guild override/);
  assert.match(text, /was assigned \*\*alpha\*\*/);
  assert.match(text, /own entrance sound applies again: \*\*beta\*\*/); // T1's own setting for this server wins over their global sound
  assert.equal(repo.hasGuildEntranceOverride(T1, GUILD), false);
  assert.equal(repo.entrance(T1, GUILD), "personal-1"); // and the stored data now resolves to the personal sound, not a suppression
  assert.deepEqual(repo.guildEntranceOverrides(GUILD), [{ userId: T2, sound: null }]); // the other override stays
  assert.deepEqual(snapshotOutsideOverrides(repo), outside);
});

test("clear releases a SUPPRESSED override: the member is no longer silenced", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo);
  assert.equal(repo.entrance(T2, GUILD), undefined); // silenced before
  const text = (await send(deps, `!guild-entrance clear ${T2}`, ENTRANCE_MANAGER)).join("\n");
  assert.match(text, /was suppressed/);
  assert.match(text, /own entrance sound applies again: \*\*personal-2\*\*/);
  assert.equal(repo.entrance(T2, GUILD), "personal-2"); // personal sound plays again
  assert.equal(repo.entrance(T2), "personal-2"); // and it was never modified
  assert.deepEqual(repo.guildEntranceOverrides(GUILD), [{ userId: T1, sound: "alpha" }]);
});

test("clear is released, not suppressed: a member with no personal sound simply has none", async (t) => {
  const { repo, deps } = setup(t);
  repo.setGuildEntrance(GUILD, T3, "alpha");
  const text = (await send(deps, `!guild-entrance clear ${T3}`, OWNER)).join("\n");
  assert.match(text, /no personal entrance sound set/);
  assert.equal(repo.guildEntranceAssignment(T3, GUILD), undefined); // deleted, not stored as ""
  assert.deepEqual(repo.guildEntranceOverrides(GUILD), []);
});

test("clear explains when automatic entrances are disabled, or the member turned them off themselves", async (t) => {
  const a = setup(t);
  a.repo.setEntrance(T1, "personal-1");
  a.repo.setGuildEntrance(GUILD, T1, "alpha");
  a.repo.setGuildEntranceSettings(GUILD, { enabled: false });
  assert.match((await send(a.deps, `!guild-entrance clear ${T1}`, OWNER)).join(""), /disabled in this server/);

  const b = setup(t);
  b.repo.setEntrance(T1, "personal-1");
  b.repo.setUserGuildEntrance(T1, GUILD, ""); // member disabled entrances for this server
  b.repo.setGuildEntrance(GUILD, T1, "alpha");
  assert.match((await send(b.deps, `!guild-entrance clear ${T1}`, OWNER)).join(""), /turned entrance sounds off for this server themselves/);
  assert.equal(b.repo.userGuildEntrance(T1, GUILD), ""); // their choice is preserved
});

test("clear on a member without an override changes nothing", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo);
  const before = JSON.stringify([repo.guildEntranceOverrides(GUILD), snapshotOutsideOverrides(repo)]);
  assert.match((await send(deps, `!guild-entrance clear ${T3}`, OWNER)).join(""), /has no guild entrance override in this server\. Nothing changed/);
  assert.equal(JSON.stringify([repo.guildEntranceOverrides(GUILD), snapshotOutsideOverrides(repo)]), before);
});

test("clear never touches the same member's override in another server", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo); // T1 has overrides in both servers
  await send(deps, `!guild-entrance clear ${T1}`, OWNER);
  assert.deepEqual(repo.guildEntranceOverrides(OTHER), [{ userId: T1, sound: "other-server" }, { userId: T3, sound: null }]);
});

// ------------------------------------------------------------------ clear-all

test("clear-all only PREVIEWS: it explains the effect and removes nothing", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo);
  const before = JSON.stringify([repo.guildEntranceOverrides(GUILD), snapshotOutsideOverrides(repo)]);
  const text = (await send(deps, "!guild-entrance clear-all", OWNER)).join("\n");
  assert.match(text, /would remove \*\*2 overrides \(1 assigned, 1 suppressed\)\*\*/);
  assert.match(text, /own entrance sound would apply here again, including members who are currently suppressed/);
  assert.match(text, /not touched/);
  assert.match(text, /`!guild-entrance clear-all confirm`/);
  assert.equal(JSON.stringify([repo.guildEntranceOverrides(GUILD), snapshotOutsideOverrides(repo)]), before);
});

test("clear-all confirm removes every override in this server only, with one save, and nothing else", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo);
  const outside = snapshotOutsideOverrides(repo);
  const flush = t.mock.method(repo, "flush");
  const text = (await send(deps, "!guild-entrance clear-all confirm", SERVER_MANAGER)).join("\n");
  assert.match(text, /Removed \*\*2\*\* guild entrance overrides/);
  assert.equal(flush.mock.callCount(), 1);
  assert.deepEqual(repo.guildEntranceOverrides(GUILD), []);
  assert.equal(repo.entrance(T1, GUILD), "personal-1"); // was assigned
  assert.equal(repo.entrance(T2, GUILD), "personal-2"); // was suppressed
  assert.deepEqual(snapshotOutsideOverrides(repo), outside); // personal sounds, own settings, policy, other server
});

test("running confirm again afterwards is harmless", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo);
  await send(deps, "!guild-entrance clear-all confirm", OWNER);
  const flush = t.mock.method(repo, "flush");
  assert.match((await send(deps, "!guild-entrance clear-all confirm", OWNER)).join(""), /nothing to clear/);
  assert.equal(flush.mock.callCount(), 0);
});

test("clear-all on an empty server says there is nothing to clear, with or without confirm", async (t) => {
  const { deps } = setup(t);
  assert.match((await send(deps, "!guild-entrance clear-all", OWNER)).join(""), /nothing to clear/);
  assert.match((await send(deps, "!guild-entrance clear-all confirm", OWNER)).join(""), /nothing to clear/);
});

test("a wrong confirmation word never deletes", async (t) => {
  const { repo, deps } = setup(t);
  populate(repo);
  for (const c of ["!guild-entrance clear-all yes", "!guild-entrance clear-all confirm now", "!guild-entrance clear-all CONFIRMED"]) {
    await send(deps, c, OWNER);
  }
  assert.equal(repo.guildEntranceOverrides(GUILD).length, 2);
});

// ------------------------------------------------------------------ help integration

test("regular users cannot discover the command: not in !help, and !help guild-entrance looks like an unknown command", async (t) => {
  const { deps } = setup(t);
  for (const who of [REGULAR, IMPORTER, CHANNEL_MANAGER]) {
    const list = (await send(deps, "!help", who)).join("\n");
    assert.doesNotMatch(list, /guild-entrance/, who);
    const hidden = (await send(deps, "!help guild-entrance", who))[0]!;
    const unknown = (await send(deps, "!help nosuchcommand", who))[0]!;
    assert.equal(hidden.replace("`guild-entrance`", "`X`"), unknown.replace("`nosuchcommand`", "`X`"), who);
  }
});

test("authorized people and the owner see it in !help, with the same access rule as the command", async (t) => {
  const { deps } = setup(t);
  for (const who of [OWNER, ENTRANCE_MANAGER, DISCORD_ADMIN, SERVER_MANAGER]) {
    assert.match((await send(deps, "!help", who)).join("\n"), /`!guild-entrance \[list\|clear\|clear-all\]`/, who);
    const detail = (await send(deps, "!help guild-entrance", who)).join("\n");
    assert.match(detail, /`!guild-entrance clear-all confirm` - remove every override in this server/, who);
    assert.doesNotMatch(detail, /🔒/, who);
    assert.match(detail, /e\.g\. `!guild-entrance clear @Sam`/, who);
  }
});

test("the same people who can run the command are exactly the ones who see it", async (t) => {
  const { deps } = setup(t);
  for (const who of [OWNER, ENTRANCE_MANAGER, DISCORD_ADMIN, SERVER_MANAGER, CHANNEL_MANAGER, IMPORTER, REGULAR]) {
    const ran = (await send(deps, "!guild-entrance list", who)).length > 0;
    const seen = /guild-entrance/.test((await send(deps, "!help", who)).join("\n"));
    assert.equal(seen, ran, who);
  }
});

test("its help metadata is complete and valid", async () => {
  const { helpProblems } = await import("./helpFormat.ts");
  assert.deepEqual(helpProblems(registry.lookup("guild-entrance")!.command), []);
});
