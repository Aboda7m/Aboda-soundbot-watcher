import { AccessPolicy } from "../src/access/AccessPolicy.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "discord.js";
import {
  COMMAND_NAME_PATTERN,
  CommandLoadError,
  createRegistry,
  describeRegistry,
  loadCommands,
  validateCommand,
} from "../src/discord/commandRegistry.ts";
import { commandWord, handleTextMessage, registerTextCommands } from "../src/discord/textCommands.ts";
import type { CommandDeps, IncomingMessage } from "../src/discord/commandTypes.ts";

/** A minimal, valid command module body (plain object: fixtures must not depend on repo imports). */
const moduleSource = (names: string[], extra = "") =>
  `export default { names: ${JSON.stringify(names)}, description: "fixture", parse: () => null, execute: async () => {}${extra} };\n`;

function fixtureDir(files: Record<string, string>, dirs: string[] = []): URL {
  const dir = mkdtempSync(join(tmpdir(), "cmdreg-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  for (const d of dirs) mkdirSync(join(dir, d));
  return pathToFileURL(dir + "/");
}

const problemsOf = async (dir: URL): Promise<readonly string[]> => {
  try {
    await loadCommands(dir);
  } catch (err) {
    assert.ok(err instanceof CommandLoadError, `expected CommandLoadError, got ${String(err)}`);
    return err.problems;
  }
  assert.fail("expected loadCommands to throw");
};

// ───────────────────────────── real commands folder ─────────────────────────────

test("the shipped commands folder loads: access, sound, soundlist, entrance (+rm-entrance), import", async () => {
  const registry = await loadCommands();
  assert.deepEqual(registry.commands.map((c) => c.command.names[0]), ["access", "entrance", "import", "sound", "soundlist"]);
  assert.deepEqual(registry.commands.map((c) => c.file), [
    "access.command.ts",
    "entrance.command.ts",
    "import.command.ts",
    "sound.command.ts",
    "soundlist.command.ts",
  ]);
  assert.equal(registry.lookup("rm-entrance"), registry.lookup("entrance"));
  assert.equal(registry.lookup("soundlist")?.file, "soundlist.command.ts");
  assert.notEqual(registry.lookup("sound"), registry.lookup("soundlist"));
  assert.equal(registry.lookup("RM-entrance"), undefined, "lookup keys are lowercase; the dispatcher lowercases the typed word");
  assert.equal(registry.lookup("nope"), undefined);
  assert.equal(describeRegistry(registry), "access, entrance (+rm-entrance), import, sound, soundlist");
});

// ───────────────────────────── discovery ─────────────────────────────

test("loads every *.command.ts, in code-unit order regardless of creation order", async () => {
  const dir = fixtureDir({
    "zeta.command.ts": moduleSource(["zeta", "z"]),
    "Alpha.command.ts": moduleSource(["upper-file"]),
    "mid.command.ts": moduleSource(["mid"]),
  });
  const registry = await loadCommands(dir);
  // sorted by canonical name: "mid" < "upper-file" < "zeta"
  assert.deepEqual(registry.commands.map((c) => c.file), ["mid.command.ts", "Alpha.command.ts", "zeta.command.ts"]);
  assert.equal(registry.lookup("z")?.file, "zeta.command.ts");
});

test("ignores dotfiles and non-source files such as README.md", async () => {
  const dir = fixtureDir({ "a.command.ts": moduleSource(["a"]), "README.md": "# notes", ".DS_Store": "x", "Thumbs.db": "x" });
  assert.deepEqual((await loadCommands(dir)).commands.map((c) => c.file), ["a.command.ts"]);
});

// ───────────────────────────── rejection ─────────────────────────────

test("rejects duplicate names across modules and names the files involved", async () => {
  const dir = fixtureDir({ "a.command.ts": moduleSource(["ping", "p"]), "b.command.ts": moduleSource(["pong", "p"]) });
  assert.deepEqual(await problemsOf(dir), ['duplicate command name "p" in a.command.ts and b.command.ts']);
});

test("an alias that equals another command's canonical name is a duplicate too", async () => {
  const dir = fixtureDir({ "a.command.ts": moduleSource(["sound"]), "b.command.ts": moduleSource(["other", "sound"]) });
  assert.match((await problemsOf(dir))[0]!, /duplicate command name "sound" in a\.command\.ts and b\.command\.ts/);
});

test("rejects a module that repeats a name", () => {
  assert.deepEqual(validateCommand({ names: ["a", "a"], description: "d", parse() {}, execute() {} }), ['name "a" is listed twice']);
});

test("validateCommand accepts a good command and explains every kind of malformed one", () => {
  const good = { names: ["ok", "also-ok_2"], description: "d", parse: () => null, execute: async () => {} };
  assert.deepEqual(validateCommand(good), []);

  assert.match(validateCommand(null)[0]!, /got null/);
  assert.match(validateCommand("text")[0]!, /got string/);
  assert.match(validateCommand(() => {})[0]!, /got function/);
  assert.deepEqual(validateCommand({ ...good, names: [] }), ["`names` must be a non-empty array of strings"]);
  assert.deepEqual(validateCommand({ ...good, names: "ok" }), ["`names` must be a non-empty array of strings"]);
  assert.equal(validateCommand({ ...good, names: ["Upper"] }).length, 1);
  assert.equal(validateCommand({ ...good, names: ["has space"] }).length, 1);
  assert.equal(validateCommand({ ...good, names: ["!bang"] }).length, 1);
  assert.equal(validateCommand({ ...good, names: [""] }).length, 1);
  assert.equal(validateCommand({ ...good, names: [42] }).length, 1);
  assert.deepEqual(validateCommand({ ...good, description: "  " }), ["`description` must be a non-empty string"]);
  assert.deepEqual(validateCommand({ ...good, parse: undefined }), ["`parse` must be a function"]);
  assert.deepEqual(validateCommand({ ...good, execute: "run" }), ["`execute` must be a function"]);
  assert.equal(validateCommand({}).length, 4);
});

test("name pattern: lowercase letters, digits, - and _", () => {
  for (const ok of ["sound", "rm-entrance", "a1", "snake_case", "9lives"]) assert.ok(COMMAND_NAME_PATTERN.test(ok), ok);
  for (const bad of ["", "-x", "_x", "Sound", "a b", "a!", "é"]) assert.ok(!COMMAND_NAME_PATTERN.test(bad), bad);
});

test("reports every problem at once: bad shape, syntax error, missing default export, stray file, subfolder", async () => {
  const dir = fixtureDir(
    {
      "good.command.ts": moduleSource(["good"]),
      "badshape.command.ts": `export default { names: ["bad"], description: "d" };\n`,
      "syntax.command.ts": `export default {\n`,
      "nodefault.command.ts": `export const command = 1;\n`,
      "typo.commmand.ts": moduleSource(["typo"]),
      "helper.ts": `export const x = 1;\n`,
      "old.js": `export const y = 1;\n`,
    },
    ["nested"],
  );
  const problems = await problemsOf(dir);
  const joined = problems.join("\n");
  assert.match(joined, /badshape\.command\.ts: `parse` must be a function/);
  assert.match(joined, /badshape\.command\.ts: `execute` must be a function/);
  assert.match(joined, /syntax\.command\.ts: failed to import: /);
  assert.match(joined, /nodefault\.command\.ts: has no default export/);
  assert.match(joined, /typo\.commmand\.ts: not loaded as a command; file names must end in \.command\.ts/);
  assert.match(joined, /helper\.ts: not loaded as a command/);
  assert.match(joined, /old\.js: not loaded as a command/);
  assert.match(joined, /nested\/: subfolders are not scanned/);
  assert.equal(problems.length, 8);
  assert.doesNotMatch(joined, /good\.command\.ts/);
});

test("the error message lists the problems, one per line", async () => {
  const dir = fixtureDir({ "a.command.ts": `export default 5;\n` });
  await assert.rejects(loadCommands(dir), (err: Error) => {
    assert.equal(err.name, "CommandLoadError");
    assert.match(err.message, /^Could not load text commands:\n {2}- a\.command\.ts: default export must be an object/);
    return true;
  });
});

test("an empty folder, a missing folder and a folder with nothing loadable are all errors", async () => {
  assert.deepEqual(await problemsOf(fixtureDir({})), ["no command modules found"]);
  assert.deepEqual(await problemsOf(fixtureDir({ "README.md": "x" })), ["no command modules found"]);
  const missing = pathToFileURL(join(tmpdir(), "definitely-not-here-cmdreg", "/"));
  assert.match((await problemsOf(missing))[0]!, /cannot read commands folder/);
  assert.throws(() => createRegistry([]), CommandLoadError);
});

// ───────────────────────────── dispatch ─────────────────────────────

test("commandWord extracts the lowercase word after the prefix, only when the prefix matches", () => {
  assert.equal(commandWord("!sound air horn", "!"), "sound");
  assert.equal(commandWord("  !RM-Entrance  ", "!"), "rm-entrance");
  assert.equal(commandWord("!sound\nnext line", "!"), "sound");
  assert.equal(commandWord("!", "!"), "");
  assert.equal(commandWord("sound", "!"), null);
  assert.equal(commandWord("", "!"), null);
  assert.equal(commandWord("?sound x", "?"), "sound");
  assert.equal(commandWord("!sound x", "?"), null);
  assert.equal(commandWord("sound x", ""), "sound");
});

/** Adding a command means adding a file: nothing else is edited. */
test("a command file dropped into the folder is discovered, aliased, routed and isolated from errors", async () => {
  const dir = fixtureDir({
    "ping.command.ts": `export default {
      names: ["ping", "pong"],
      description: "replies",
      parse: (content, prefix) => {
        const rest = content.trim().slice(prefix.length).split(/\\s+/).slice(1).join(" ");
        return { rest };
      },
      execute: async ({ message, guildId }, parsed) => { await message.reply("pong " + guildId + " " + parsed.rest); },
    };\n`,
    "never.command.ts": `export default {
      names: ["never"], description: "parse says no", parse: () => null,
      execute: async ({ message }) => { await message.reply("SHOULD NOT RUN"); },
    };\n`,
    "boom.command.ts": `export default {
      names: ["boom"], description: "throws", parse: () => ({}),
      execute: async () => { throw new Error("kaboom"); },
    };\n`,
  });

  const listeners: ((m: unknown) => unknown)[] = [];
  const client = { on: (_e: string, fn: (m: unknown) => unknown) => void listeners.push(fn) } as unknown as Client;
  const lines: string[] = [];
  const deps = { prefix: "!", access: AccessPolicy.inMemory([]) } as unknown as CommandDeps;
  await registerTextCommands(client, deps, { commandsDir: dir, log: (l) => lines.push(l) });
  assert.deepEqual(lines, ['Text commands (prefix "!"): boom, never, ping (+pong)']);
  assert.equal(listeners.length, 1);

  const replies: string[] = [];
  const msg = (content: string, extra: Partial<IncomingMessage> = {}) =>
    ({
      content,
      author: { id: "u", bot: false, send: async () => {} },
      guild: { id: "g7" },
      reply: async (o: string | { content: string }) => void replies.push(typeof o === "string" ? o : o.content),
      react: async () => {},
      ...extra,
    }) as unknown as IncomingMessage;

  await listeners[0]!(msg("!ping a b"));
  await listeners[0]!(msg("!PONG   x"));
  await listeners[0]!(msg("!never"));
  await listeners[0]!(msg("!ping", { guild: null }));
  await listeners[0]!(msg("!ping", { author: { id: "b", bot: true, send: async () => {} } }));
  await listeners[0]!(msg("!sound x")); // not a discovered command: silently ignored
  assert.deepEqual(replies, ["pong g7 a b", "pong g7 x"]);

  const registry = await loadCommands(dir);
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    await assert.doesNotReject(handleTextMessage(msg("!boom"), registry, deps));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0]![0], "Text command failed:");
  assert.equal((logged[0]![1] as Error).message, "kaboom");
});

test("registerTextCommands rejects (and registers no listener) when a command module is invalid", async () => {
  const dir = fixtureDir({ "bad.command.ts": `export default { names: ["bad"] };\n` });
  let listeners = 0;
  const client = { on: () => void listeners++ } as unknown as Client;
  await assert.rejects(registerTextCommands(client, { prefix: "!" } as unknown as CommandDeps, { commandsDir: dir }), CommandLoadError);
  assert.equal(listeners, 0);
});
