import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AccessPolicy } from "../access/AccessPolicy.ts";
import { RecordingPermissions } from "../recording/RecordingPermissions.ts";
import { createRegistry, loadCommands, type CommandRegistry } from "./commandRegistry.ts";
import type { CommandContext, CommandDeps, IncomingMessage } from "./commandTypes.ts";
import { formatDetail, formatHelpWarning, formatOverview, helpProblems } from "./helpFormat.ts";
import { parseHelpCommand } from "./textCommand.ts";
import { handleTextMessage, registerTextCommands } from "./textCommands.ts";

const OWNER = "100000000000000001";
const ADMIN = "100000000000000002"; // Discord Administrator, no bot grants
const MANAGER = "100000000000000003"; // Manage Channels + Move Members
const IMPORTER = "100000000000000004"; // bot grant: import
const REGULAR = "100000000000000005";
const GUILD = "200000000000000001";

const BITS = { admin: 1n << 3n, manageChannels: 1n << 4n, manageGuild: 1n << 5n, moveMembers: 1n << 24n };
const PERMS: Record<string, bigint[]> = { [ADMIN]: [BITS.admin], [MANAGER]: [BITS.manageChannels, BITS.moveMembers] };

const registry = await loadCommands(); // the real ./commands/ folder, through the real loader

function makeAccess(): AccessPolicy {
  const access = AccessPolicy.inMemory([OWNER]);
  access.grant(IMPORTER, "import");
  return access;
}

function makeDeps(access = makeAccess(), extra: Partial<CommandDeps> = {}): CommandDeps {
  return {
    library: { list: () => [] },
    queue: {},
    prefix: "!",
    importer: {},
    repo: {},
    access,
    voiceHub: { describe: () => [] },
    followRecorder: {},
    streamManager: {},
    ...extra,
  } as unknown as CommandDeps;
}

/** A discord.js-shaped message whose replies are captured. `perms` are the Discord permission bits the member holds. */
function fakeMessage(content: string, userId: string, replies: string[]): IncomingMessage {
  const held = PERMS[userId] ?? [];
  const reply = async (o: string | { content: string }) => {
    replies.push(typeof o === "string" ? o : o.content);
    return { edit: async () => {} };
  };
  return {
    content,
    author: { id: userId, bot: false, tag: "t#0", send: async () => {} },
    guild: { id: GUILD },
    member: { id: userId, permissions: { has: (b: bigint) => held.includes(b) }, voice: { channelId: null } },
    reply,
    react: async () => {},
  } as unknown as IncomingMessage;
}

async function send(content: string, userId: string, deps = makeDeps(), reg: CommandRegistry = registry): Promise<string[]> {
  const replies: string[] = [];
  await handleTextMessage(fakeMessage(content, userId, replies), reg, deps);
  return replies;
}

const ctxFor = (userId: string, deps = makeDeps()): CommandContext => ({ message: fakeMessage("!x", userId, []), guildId: GUILD, deps, registry });

// ------------------------------------------------------------------ real registry

test("the real commands folder loads, with no duplicate names, and `help`/`commands` are registered", () => {
  const names = registry.commands.flatMap((c) => c.command.names);
  assert.equal(new Set(names).size, names.length);
  assert.equal(registry.lookup("help"), registry.lookup("commands"));
  for (const n of ["access", "entrance", "rm-entrance", "entrance-policy", "exit", "import", "record", "sound", "soundlist", "voice", "help"]) {
    assert.ok(registry.lookup(n), `missing command ${n}`);
  }
});

test("every registered command has complete help metadata, so startup prints no warning", () => {
  for (const { command } of registry.commands) assert.deepEqual(helpProblems(command), [], command.names[0]);
  assert.equal(formatHelpWarning(registry, "!"), null);
});

// ------------------------------------------------------------------ dispatch: !help and !commands

test("!help and !commands go through the dispatcher and give the same answer", async () => {
  const a = await send("!help", REGULAR);
  const b = await send("!commands", REGULAR);
  const c = await send("!COMMANDS", REGULAR);
  assert.ok(a.length >= 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.match(a.join("\n"), /`!sound "<name>"`/);
  assert.ok(a.every((m) => m.length <= 1900));
});

test("the whitelist still silences !help for people the bot ignores", async () => {
  const access = makeAccess();
  access.setWhitelist(true);
  assert.deepEqual(await send("!help", REGULAR, makeDeps(access)), []);
  assert.ok((await send("!help", OWNER, makeDeps(access))).length >= 1); // owners bypass it, as everywhere else
});

test("a custom prefix is used in the output", async () => {
  const text = (await send("?help", REGULAR, makeDeps(makeAccess(), { prefix: "?" }))).join("\n");
  assert.match(text, /`\?sound "<name>"`/);
  assert.doesNotMatch(text, /`!/);
});

// ------------------------------------------------------------------ visibility

test("a regular user does not see !access, in the list or by name; the answer matches an unknown command", async () => {
  const list = (await send("!help", REGULAR)).join("\n");
  assert.doesNotMatch(list, /access/i);
  const hidden = await send("!help access", REGULAR);
  const unknown = await send("!help nosuchcommand", REGULAR);
  assert.equal(hidden[0]!.replace("`access`", "`X`"), unknown[0]!.replace("`nosuchcommand`", "`X`"));
});

test("the owner sees !access and all of its forms", async () => {
  assert.match((await send("!help", OWNER)).join("\n"), /`!access /);
  const detail = (await send("!help access", OWNER)).join("\n");
  assert.match(detail, /`!access grant\|revoke <@user\|id> <dashboard\|import\|entrance\.manage/);
  assert.match(detail, /`!access whitelist on\|off`/);
});

test("!access itself stays silent for non-owners and answers owners (behavior unchanged)", async () => {
  assert.deepEqual(await send("!access", REGULAR), []);
  assert.deepEqual(await send("!access", ADMIN), []);
  assert.match((await send("!access", OWNER)).join("\n"), /Access settings/);
});

test("!import: locked for a user without the grant, open with it; shows when the service is disabled", async () => {
  const regular = (await send("!help import", REGULAR)).join("\n");
  assert.match(regular, /🔒 `!import <YouTube URL>/);
  assert.doesNotMatch(regular, /e\.g\./); // locked forms do not reveal examples
  const importer = (await send("!help import", IMPORTER)).join("\n");
  assert.doesNotMatch(importer, /🔒/);
  assert.match(importer, /e\.g\./);
  const off = (await send("!help import", IMPORTER, makeDeps(makeAccess(), { importer: undefined }))).join("\n");
  assert.match(off, /unavailable right now: the import service is disabled/);
});

test("!entrance: managing someone else is locked without entrance.manage", async () => {
  const regular = (await send("!help entrance", REGULAR)).join("\n");
  assert.match(regular, /🔒 `!entrance @user <sound>`/);
  assert.match(regular, /`!entrance <sound>` - set your entrance sound/);
  const access = makeAccess();
  access.grant(REGULAR, "entrance.manage");
  assert.doesNotMatch((await send("!help entrance", REGULAR, makeDeps(access))).join("\n"), /🔒/);
});

test("!record help matches RecordingPermissions.canUserRecord for every kind of member (refactor equivalence)", () => {
  const access = makeAccess();
  const record = registry.lookup("record")!.command;
  const checks = (record.help!.usages as readonly { requires?: { check(c: CommandContext): boolean } }[]).filter((u) => u.requires).map((u) => u.requires!.check);
  assert.equal(checks.length, 4); // start, stop, attach, detach

  const cases: [string, bigint[], string][] = [
    ["owner", [], OWNER],
    ["administrator", [BITS.admin], ADMIN],
    ["manage channels + move members", [BITS.manageChannels, BITS.moveMembers], MANAGER],
    ["manage channels only", [BITS.manageChannels], REGULAR],
    ["move members only", [BITS.moveMembers], REGULAR],
    ["manage server only", [BITS.manageGuild], REGULAR],
    ["nothing", [], REGULAR],
  ];
  for (const [label, held, id] of cases) {
    const member = { id, permissions: { has: (b: bigint) => held.includes(b) } };
    const original = !!(member && RecordingPermissions.canUserRecord(member, access)); // the condition record.command.ts used before the refactor
    const ctx = { message: { author: { id }, member }, guildId: GUILD, deps: makeDeps(access) } as unknown as CommandContext;
    for (const check of checks) assert.equal(check(ctx), original, label);
  }
  // No member at all (e.g. a partial message) is denied, exactly as `msg.member && ...` was.
  const noMember = { message: { author: { id: REGULAR }, member: null }, guildId: GUILD, deps: makeDeps(access) } as unknown as CommandContext;
  for (const check of checks) assert.equal(check(noMember), false);
});

test("!record execute keeps its original denial text and still lets permitted members through the gate", async () => {
  const denied = await send("!record start", REGULAR);
  assert.deepEqual(denied, ["You do not have permission to manage recordings (owner, Administrator, or Manage Channels + Move Members)."]);
  assert.deepEqual(await send("!record attach @x", REGULAR), denied);
  // Past the gate the next step is "join a voice channel", which these fakes are not in.
  assert.deepEqual(await send("!record start", ADMIN), ["Join a voice channel first."]);
  assert.deepEqual(await send("!record start", MANAGER), ["Join a voice channel first."]);
  assert.deepEqual(await send("!record start", OWNER), ["Join a voice channel first."]);
  // Read-only subcommands stay open to everyone.
  assert.doesNotMatch((await send("!record status", REGULAR)).join(""), /permission/);
});

test("!voice setup: help and execute agree (Administrator only; reports when no worker is configured)", async () => {
  const regular = (await send("!help voice", REGULAR)).join("\n");
  assert.match(regular, /🔒 `!voice setup`/);
  assert.match(regular, /`!voice status` - /);
  const admin = (await send("!help voice", ADMIN)).join("\n");
  assert.doesNotMatch(admin, /🔒/);
  assert.match(admin, /unavailable right now: no voice worker tokens/);
  const withWorker = makeDeps(makeAccess(), { voiceHub: { describe: () => [{ worker: true, label: "Worker 1", userId: "1", tag: null, inGuild: true, channelId: null, state: "idle", id: "w" }] } as unknown as CommandDeps["voiceHub"] });
  assert.doesNotMatch((await send("!help voice", ADMIN, withWorker)).join("\n"), /unavailable right now/);
  // execute
  assert.deepEqual(await send("!voice setup", REGULAR), ["Only a server Administrator can authorize the worker bots."]);
  assert.match((await send("!voice setup", ADMIN))[0]!, /No worker tokens are configured/);
});

test("!entrance-policy: help and execute agree (Administrator, Manage Server or entrance.manage)", async () => {
  const regular = (await send("!help entrance-policy", REGULAR)).join("\n");
  assert.match(regular, /🔒 `!entrance-policy`/);
  assert.doesNotMatch(regular, /e\.g\./);
  assert.doesNotMatch((await send("!help entrance-policy", ADMIN)).join("\n"), /🔒/);
  const policy = registry.lookup("entrance-policy")!.command;
  const check = (policy.help!.usages[0] as { requires: { check(c: CommandContext): boolean } }).requires.check;
  const access = makeAccess();
  access.grant(IMPORTER, "entrance.manage");
  const mk = (id: string, held: bigint[]) =>
    ({ message: { author: { id }, member: { id, permissions: { has: (b: bigint) => held.includes(b) } } }, guildId: GUILD, deps: makeDeps(access) }) as unknown as CommandContext;
  assert.equal(check(mk(REGULAR, [])), false);
  assert.equal(check(mk(REGULAR, [BITS.admin])), true);
  assert.equal(check(mk(REGULAR, [BITS.manageGuild])), true);
  assert.equal(check(mk(IMPORTER, [])), true);
  assert.equal(check(mk(OWNER, [])), true);
  // execute: a non-admin gets the existing denial
  assert.match((await send("!entrance-policy", REGULAR))[0]!, /Only this server's owner\/admin/);
});

test("!exit and !soundlist and !sound have help and appear for everyone", async () => {
  const list = (await send("!help", REGULAR)).join("\n");
  for (const n of ["exit", "sound", "soundlist", "entrance", "record", "voice", "help"]) assert.match(list, new RegExp("`!" + n));
  assert.match((await send("!help exit", REGULAR)).join("\n"), /`!exit <sound>` - set your exit sound/);
});

// ------------------------------------------------------------------ incomplete metadata

const base = { description: "does a thing", parse: () => ({}), execute: async () => {} };
const good = { summary: "Good.", usages: [{ usage: "{p}good", summary: "does good", examples: ["{p}good"] }] };

function brokenRegistry(): CommandRegistry {
  return createRegistry([
    { file: "help.command.ts", value: registry.lookup("help")!.command }, // the real !help, over a registry with broken commands
    { file: "good.command.ts", value: { ...base, names: ["good"], help: good } },
    { file: "none.command.ts", value: { ...base, names: ["none", "nada"] } },
    { file: "partial.command.ts", value: { ...base, names: ["partial"], help: { summary: "Has a summary.", usages: [{ usage: "{p}partial", summary: "x" }, { usage: "{p}partial b", summary: "y", examples: ["{p}partial b"] }] } } },
    { file: "garbage.command.ts", value: { ...base, names: ["garbage"], help: "nope" } },
    { file: "badreq.command.ts", value: { ...base, names: ["badreq"], help: { summary: "s", usages: [{ usage: "{p}b", summary: "x", examples: ["{p}b"], requires: { check: () => true } }] } } },
  ]);
}

test("incomplete or malformed help never breaks registration", () => {
  assert.equal(brokenRegistry().commands.length, 6);
});

test("helpProblems names the exact missing fields", () => {
  const r = brokenRegistry();
  const p = (n: string) => helpProblems(r.lookup(n)!.command);
  assert.deepEqual(p("good"), []);
  assert.deepEqual(p("none"), ["help"]);
  assert.deepEqual(p("partial"), ["help.usages[0].examples"]);
  assert.deepEqual(p("garbage"), ["help (must be an object)"]);
  assert.deepEqual(p("badreq"), ["help.usages[0].requires.label"]);
  // required vs optional
  const only = (help: unknown) => helpProblems({ ...base, names: ["x"], help } as never);
  assert.deepEqual(only({}), ["help.summary", "help.usages"]);
  assert.deepEqual(only({ ...good, synopsis: "{p}g", notes: ["n"] }), []); // optional fields may be present
  assert.deepEqual(only({ ...good, notes: [1] }), ["help.notes"]);
  assert.deepEqual(only({ summary: "s", usages: [{ usage: "u", summary: "s", examples: [] }] }), ["help.usages[0].examples"]);
});

test("one startup warning lists every affected command with aliases and fields", () => {
  const warning = formatHelpWarning(brokenRegistry(), "!")!;
  assert.equal(warning.split("\n").filter((l) => l.startsWith("  - ")).length, 4);
  assert.match(warning, /4 of 6 command\(s\)/);
  assert.match(warning, /!none \(aliases: !nada\): missing or invalid help$/m);
  assert.match(warning, /!partial: missing or invalid help\.usages\[0\]\.examples/);
  assert.doesNotMatch(warning, /!good/);
});

test("registerTextCommands prints that warning exactly once, and nothing when help is complete", async () => {
  const handlers: ((m: unknown) => Promise<void>)[] = [];
  const client = { on: (_e: unknown, h: (m: unknown) => Promise<void>) => void handlers.push(h) };

  const warnings: string[] = [];
  await registerTextCommands(client as never, makeDeps(), { log: () => {}, warn: (m: string) => void warnings.push(m) });
  assert.equal(warnings.length, 0);
  assert.equal(handlers.length, 1);

  const dir = mkdtempSync(join(tmpdir(), "help-cmds-"));
  try {
    writeFileSync(join(dir, "plain.command.ts"), `export default { names: ["plain", "p"], description: "d", parse: () => ({}), execute: async () => {} };\n`);
    writeFileSync(join(dir, "ok.command.ts"), `export default { names: ["ok"], description: "d", parse: () => ({}), execute: async () => {}, help: ${JSON.stringify(good)} };\n`);
    const lines: string[] = [];
    await registerTextCommands(client as never, makeDeps(), { commandsDir: pathToFileURL(dir + "/"), log: (l: string) => void lines.push(l), warn: (m: string) => void warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /!plain \(aliases: !p\): missing or invalid help/);
    assert.equal(lines.length, 1); // the normal startup line is unchanged
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regular users: incomplete commands are invisible, and lookups match an unknown command", async () => {
  const r = brokenRegistry();
  const list = (await send("!help", REGULAR, makeDeps(), r)).join("\n");
  assert.match(list, /`!good`/);
  assert.doesNotMatch(list, /none|nada|partial|garbage|badreq/);
  const unknown = (await send("!help zzz", REGULAR, makeDeps(), r))[0]!.replace("`zzz`", "`X`");
  for (const n of ["none", "nada", "partial", "garbage", "badreq"]) {
    assert.equal((await send(`!help ${n}`, REGULAR, makeDeps(), r))[0]!.replace(`\`${n}\``, "`X`"), unknown, n);
  }
});

test("the owner sees every registered command, and the exact missing fields of the incomplete ones", async () => {
  const r = brokenRegistry();
  const list = (await send("!help", OWNER, makeDeps(), r)).join("\n");
  for (const n of ["good", "none", "partial", "garbage", "badreq"]) assert.match(list, new RegExp("`!" + n + "`"), n);
  assert.match(list, /`!none` \(also `!nada`\) - help incomplete, missing: `help`/);
  assert.match(list, /`!partial` - help incomplete, missing: `help\.usages\[0\]\.examples`/);

  const detail = (await send("!help nada", OWNER, makeDeps(), r)).join("\n"); // by alias
  assert.match(detail, /\*\*!none\*\*/);
  assert.match(detail, /Registered description: does a thing/);
  assert.match(detail, /• `help`/);
  assert.match((await send("!help partial", OWNER, makeDeps(), r)).join("\n"), /• `help\.usages\[0\]\.examples`/);
});

test("the owner sees restricted forms of complete commands too (locked when their own check fails)", async () => {
  const detail = (await send("!help voice", OWNER)).join("\n"); // owner without Discord Administrator
  assert.match(detail, /🔒 `!voice setup` - .*\(needs the server Administrator permission\)/);
});

test("a check or an unavailable() that throws never grants access", () => {
  const r = createRegistry([
    {
      file: "t.command.ts",
      value: { ...base, names: ["t"], help: { summary: "T.", usages: [
        { usage: "{p}t", summary: "hidden", examples: ["{p}t"], requires: { label: "l", check: () => { throw new Error("x"); } } },
        { usage: "{p}t b", summary: "open", examples: ["{p}t b"], unavailable: () => { throw new Error("y"); } },
      ] } },
    },
  ]);
  const detail = formatDetail(r, "t", ctxFor(REGULAR)).join("\n");
  assert.doesNotMatch(detail, /hidden/);
  assert.match(detail, /`!t b` - open/);
  assert.doesNotMatch(detail, /unavailable/);
});

test("overview chunks stay under Discord's limit even with very many commands", () => {
  const many = createRegistry(
    Array.from({ length: 120 }, (_, i) => ({
      file: `c${String(i).padStart(3, "0")}.command.ts`,
      value: { ...base, names: [`cmd${i}`], help: { summary: "A fairly long summary line to push the total size up. ".repeat(2), usages: [{ usage: `{p}cmd${i}`, summary: "s", examples: [`{p}cmd${i}`] }] } },
    })),
  );
  const chunks = formatOverview(many, ctxFor(REGULAR));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 1900));
});

// ------------------------------------------------------------------ parser

test("parseHelpCommand", () => {
  assert.deepEqual(parseHelpCommand("!help"), { kind: "help-overview" });
  assert.deepEqual(parseHelpCommand("!COMMANDS"), { kind: "help-overview" });
  assert.deepEqual(parseHelpCommand('!help "Record" now'), { kind: "help-detail", topic: "record" });
  assert.deepEqual(parseHelpCommand('!help "import" x'), { kind: "help-detail", topic: "import" });
  assert.deepEqual(parseHelpCommand("!help !sound"), { kind: "help-detail", topic: "sound" });
  assert.deepEqual(parseHelpCommand("?help ?sound", "?"), { kind: "help-detail", topic: "sound" });
  assert.equal(parseHelpCommand("!helpme"), null);
  assert.equal(parseHelpCommand("!commandsx"), null);
  assert.equal(parseHelpCommand("!sound"), null);
});
