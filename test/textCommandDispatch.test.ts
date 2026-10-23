/**
 * End-to-end characterization of the text commands through the real `registerTextCommands` listener.
 *
 * These tests pin the user-visible behaviour of `!sound`, `!soundlist`, `!entrance` / `!RM-entrance` and
 * `!import` (replies, permissions, queue calls, ignore rules). They were first run against the
 * single-file implementation and must keep passing unchanged against the modular one.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionFlagsBits, type Client } from "discord.js";
import { registerTextCommands } from "../src/discord/textCommands.ts";
import { SoundRepository } from "../src/sound/SoundRepository.ts";
import type { SoundLibrary } from "../src/sound/SoundLibrary.ts";
import type { EnqueueResult, PlayRequest, SoundQueue } from "../src/sound/SoundQueue.ts";
import type { ImportService } from "../src/import/ImportService.ts";

const NAMES = ["airhorn", "air horn 2", "vine boom"];

interface MsgOpts {
  authorId?: string;
  bot?: boolean;
  inGuild?: boolean;
  /** Permission bits the author holds. `null` = no member object at all. */
  perms?: bigint[] | null;
  /** Voice channel the author is in. */
  voice?: string | null;
  dmFails?: boolean;
}

interface Sent {
  replies: { content: string; noMentions: boolean }[];
  reactions: string[];
  edits: string[];
  dms: string[];
}

function makeMessage(content: string, o: MsgOpts = {}) {
  const sent: Sent = { replies: [], reactions: [], edits: [], dms: [] };
  const perms = o.perms === undefined ? [] : o.perms;
  const message = {
    content,
    author: {
      id: o.authorId ?? "u1",
      bot: o.bot ?? false,
      send: async (c: string) => {
        if (o.dmFails) throw new Error("Cannot send messages to this user");
        sent.dms.push(c);
      },
    },
    guild: o.inGuild === false ? null : { id: "g1" },
    member:
      perms === null
        ? null
        : {
            permissions: { has: (p: bigint) => perms.includes(p) },
            voice: { channelId: o.voice === undefined ? "vc1" : o.voice },
          },
    reply: async (options: string | { content: string; allowedMentions?: { parse: never[] } }) => {
      if (typeof options === "string") sent.replies.push({ content: options, noMentions: false });
      else sent.replies.push({ content: options.content, noMentions: options.allowedMentions?.parse.length === 0 });
      return { edit: async (c: string) => void sent.edits.push(c) };
    },
    react: async (e: string) => void sent.reactions.push(e),
  };
  return { message, sent };
}

interface SetupOpts {
  names?: string[];
  prefix?: string;
  withRepo?: boolean;
  importer?: Partial<Record<"status" | "importYouTube" | "process" | "save", unknown>> | null;
  enqueue?: (req: PlayRequest) => EnqueueResult;
}

async function setup(o: SetupOpts = {}) {
  const names = o.names ?? [...NAMES];
  const prefix = o.prefix ?? "!";
  const listeners: { event: string; fn: (m: unknown) => unknown }[] = [];
  const client = {
    on(event: string, fn: (m: unknown) => unknown) {
      listeners.push({ event, fn });
      return client;
    },
  } as unknown as Client;

  let invalidated = 0;
  const library = {
    list: () => names,
    has: (n: string) => names.includes(n),
    invalidate: () => void invalidated++,
  } as unknown as SoundLibrary;

  const enqueued: PlayRequest[] = [];
  const queue = {
    enqueue: (req: PlayRequest) => {
      enqueued.push(req);
      return o.enqueue ? o.enqueue(req) : ({ ok: true, position: 0 } as EnqueueResult);
    },
  } as unknown as SoundQueue;

  const dbPath = join(mkdtempSync(join(tmpdir(), "dispatch-")), "db.json");
  writeFileSync(dbPath, JSON.stringify({ entrances: {}, exits: {}, ignoreList: [], sounds: [] }));
  const repo = new SoundRepository(dbPath, { countPlays: false });

  const importCalls = { process: [] as unknown[], save: [] as unknown[], urls: [] as string[] };
  const defaultImporter = {
    status: async () => ({ ready: true }),
    importYouTube: async (url: string) => {
      importCalls.urls.push(url);
      return { id: "s1", suggestedName: "clip" };
    },
    process: async (id: string, req: unknown) => void importCalls.process.push([id, req]),
    save: async (id: string, name: string) => {
      importCalls.save.push([id, name]);
      return { name, file: `${name}.mp3` };
    },
  };
  const importer =
    o.importer === null ? undefined : ({ ...defaultImporter, ...(o.importer ?? {}) } as unknown as ImportService);

  await registerTextCommands(
    client,
    { library, queue, prefix, importer, repo: o.withRepo === false ? undefined : repo },
    { log: () => {} },
  );

  const listener = listeners.find((l) => l.event === "messageCreate");
  assert.ok(listener, "registerTextCommands must listen to messageCreate");
  assert.equal(listeners.length, 1, "exactly one messageCreate listener");

  const send = async (content: string, mo: MsgOpts = {}) => {
    const { message, sent } = makeMessage(content, mo);
    await listener.fn(message);
    return sent;
  };
  return { send, enqueued, repo, importCalls, invalidated: () => invalidated };
}

const ADMIN = [PermissionFlagsBits.Administrator];
const MANAGER = [PermissionFlagsBits.ManageGuild];

// ───────────────────────────── ignore rules ─────────────────────────────

test("dispatch ignores bots, DMs, plain text and near-miss command names", async () => {
  const { send, enqueued } = await setup();
  const ignored: [string, MsgOpts?][] = [
    ["!sound vine boom", { bot: true }],
    ["!soundlist", { bot: true }],
    ["!sound vine boom", { inGuild: false }],
    ["!import https://x.test/v", { inGuild: false }],
    ["hello there"],
    ["hello !sound vine boom"],
    ["!soundcheck"],
    ["!soundlists"],
    ["!entrances"],
    ["!importer https://x.test/v"],
    ["!rm-entrances"],
    ["!sound\u200b vine boom"],
    ["!"],
    [""],
    ["!unknown thing"],
  ];
  for (const [content, mo] of ignored) {
    const s = await send(content, mo);
    assert.deepEqual(s, { replies: [], reactions: [], edits: [], dms: [] }, `should ignore: ${JSON.stringify(content)}`);
  }
  assert.equal(enqueued.length, 0);
});

test("a throwing handler is logged and never escapes the listener", async () => {
  const errors = mock.method(console, "error", () => {});
  try {
    const { send } = await setup({
      enqueue: () => {
        throw new Error("queue exploded");
      },
    });
    await assert.doesNotReject(send("!sound vine boom"));
    assert.equal(errors.mock.callCount(), 1);
    assert.equal(errors.mock.calls[0]!.arguments[0], "Text command failed:");
  } finally {
    errors.mock.restore();
  }
});

// ───────────────────────────── !sound ─────────────────────────────

test("!sound usage when no name is given", async () => {
  const { send } = await setup();
  const s = await send("!sound");
  assert.deepEqual(s.replies, [{ content: 'Usage: `!sound "name"`  (3 sounds available)', noMentions: false }]);
  assert.deepEqual((await send('!sound ""')).replies, s.replies);
});

test("!sound plays in the caller's voice channel and reacts; heads are case-insensitive", async () => {
  const { send, enqueued } = await setup();
  for (const text of ["!sound vine boom", "!SOUND VINE BOOM", '!sound "vine boom"', "  !Sound   vine boom  ", "!sound vine boomm"]) {
    const s = await send(text, { voice: "vc9" });
    assert.deepEqual(s.reactions, ["🔊"], text);
    assert.deepEqual(s.replies, [], text);
  }
  assert.equal(enqueued.length, 5);
  for (const req of enqueued) assert.deepEqual(req, { sound: "vine boom", guildId: "g1", channelId: "vc9", source: "manual" });
});

test("!sound honours a custom prefix and ignores the default one", async () => {
  const { send, enqueued } = await setup({ prefix: "?" });
  assert.deepEqual((await send("?sound vine boom")).reactions, ["🔊"]);
  assert.deepEqual(await send("!sound vine boom"), { replies: [], reactions: [], edits: [], dms: [] });
  assert.equal(enqueued.length, 1);
});

test("!sound without a voice channel (or without a member) asks the caller to join one", async () => {
  const { send, enqueued } = await setup();
  for (const mo of [{ voice: null }, { perms: null }] as MsgOpts[]) {
    const s = await send("!sound vine boom", mo);
    assert.deepEqual(s.replies, [{ content: "Join a voice channel first.", noMentions: false }]);
    assert.deepEqual(s.reactions, []);
  }
  assert.equal(enqueued.length, 0);
});

test("!sound: unknown, ambiguous and suggested names reply without queueing (no mentions allowed)", async () => {
  const { send, enqueued } = await setup({ names: ["Bruh", "bruh", "vine boom"] });
  assert.deepEqual((await send("!sound qwertyuiop")).replies, [
    { content: 'No sound called "qwertyuiop". Try `!soundlist`.', noMentions: true },
  ]);
  assert.deepEqual((await send("!sound BRUH")).replies, [
    { content: '"BRUH" matches several sounds: **Bruh**, **bruh**. Be more specific.', noMentions: true },
  ]);
  assert.deepEqual((await send("!sound vine bom")).replies, [
    {
      content:
        'I\'m not sure which sound you mean by "vine bom". Did you mean: **vine boom**? Be more specific, or see `!soundlist`.',
      noMentions: true,
    },
  ]);
  assert.equal(enqueued.length, 0);
});

test("!sound reports each queue failure with its own message and no reaction", async () => {
  const texts = {
    "unknown-sound": "I don't know that sound.",
    "queue-full": "The queue is full, try again in a moment.",
    duplicate: "That sound is already queued for your channel.",
    "shutting-down": "I'm shutting down.",
  } as const;
  for (const [reason, text] of Object.entries(texts)) {
    const { send } = await setup({ enqueue: () => ({ ok: false, reason: reason as keyof typeof texts }) });
    const s = await send("!sound vine boom");
    assert.deepEqual(s.replies, [{ content: text, noMentions: false }], reason);
    assert.deepEqual(s.reactions, [], reason);
  }
});

// ───────────────────────────── !soundlist ─────────────────────────────

test("!soundlist DMs the sorted list and confirms; closed DMs get a hint", async () => {
  const { send } = await setup();
  const ok = await send("!soundlist extra args are ignored");
  assert.deepEqual(ok.dms, ["**Available sounds (3):**\n• air horn 2\n• airhorn\n• vine boom"]);
  assert.deepEqual(ok.replies, [{ content: "📬 Sent you a DM with all 3 sound names.", noMentions: true }]);

  const closed = await send("!SoundList", { dmFails: true });
  assert.deepEqual(closed.dms, []);
  assert.equal(closed.replies.length, 1);
  assert.match(closed.replies[0]!.content, /^I couldn't DM you\./);

  const empty = await (await setup({ names: [] })).send("!soundlist");
  assert.deepEqual(empty.replies, [{ content: "There are no sounds in the library yet.", noMentions: true }]);
});

// ───────────────────────────── !entrance ─────────────────────────────

test("!entrance: caller shows, sets (canonical name), replaces and clears their own", async () => {
  const { send, repo } = await setup();
  const say = async (t: string, mo?: MsgOpts) => {
    const s = await send(t, mo);
    assert.equal(s.replies.length, 1, t);
    assert.equal(s.replies[0]!.noMentions, true, t);
    return s.replies[0]!.content;
  };
  assert.equal(await say("!entrance"), "You have no entrance sound set. Set one with `!entrance <sound>`.");
  assert.equal(await say("!entrance vine boom"), "Your's entrance sound is now **vine boom**.");
  assert.equal(repo.entrance("u1"), "vine boom");
  assert.equal(
    await say("!entrance"),
    "Your entrance sound is **vine boom**. Change it with `!entrance <sound>` or clear it with `!entrance !clear`.",
  );
  assert.equal(await say("!entrance AIRHORN"), "Your's entrance sound is now **airhorn**.");
  assert.equal(repo.entrance("u1"), "airhorn");
  assert.equal(await say("!entrance !clear"), "Cleared your entrance sound.");
  assert.equal(repo.entrance("u1"), undefined);
  repo.setEntrance("u1", "vine boom");
  assert.equal(await say("!RM-entrance"), "Cleared your entrance sound.");
  assert.equal(repo.entrance("u1"), undefined);
  repo.setEntrance("u1", "vine boom");
  assert.equal(await say("!rm-entrance with trailing words"), "Cleared your entrance sound.");
  assert.equal(repo.entrance("u1"), undefined);
});

test("!entrance: stale assignment is reported, unknown/partial/ambiguous names never save", async () => {
  const { send, repo } = await setup({ names: ["airhorn", "air horn 2", "vine boom", "Bruh", "bruh"] });
  repo.setEntrance("u1", "gone");
  assert.equal(
    (await send("!entrance")).replies[0]!.content,
    "Your entrance sound is **gone** (that sound no longer exists, so nothing will play). Change it with `!entrance <sound>` or clear it with `!entrance !clear`.",
  );
  assert.equal((await send("!entrance nothing")).replies[0]!.content, 'No sound called "nothing". See `!soundlist`.');
  assert.equal(
    (await send("!entrance horn")).replies[0]!.content,
    'No sound called "horn". Did you mean: **airhorn**, **air horn 2**?',
  );
  assert.equal(
    (await send("!entrance BRUH")).replies[0]!.content,
    "Several sounds are named like that: **Bruh**, **bruh**. Use the exact name.",
  );
  assert.equal(repo.entrance("u1"), "gone");
});

test("!entrance: managing another member requires Manage Server or Administrator", async () => {
  const { send, repo } = await setup();
  const denied = "You need the Manage Server or Administrator permission to manage another member's entrance sound.";
  for (const t of ["!entrance <@999>", "!entrance <@999> vine boom", "!entrance <@999> !clear", "!entrance <@!999> vine boom"]) {
    for (const perms of [[], null] as (bigint[] | null)[]) {
      const s = await send(t, { perms });
      assert.deepEqual(s.replies, [{ content: denied, noMentions: true }], t);
    }
  }
  assert.equal(repo.entrance("999"), undefined);
  assert.equal(repo.entrance("u1"), undefined);

  for (const perms of [MANAGER, ADMIN]) {
    const say = async (t: string) => (await send(t, { perms })).replies[0]!.content;
    assert.equal(await say("!entrance <@999>"), "<@999> has no entrance sound set.");
    assert.equal(await say("!entrance <@999> vine boom"), "<@999>'s entrance sound is now **vine boom**.");
    assert.equal(repo.entrance("999"), "vine boom");
    assert.equal(await say("!entrance <@999>"), "<@999>'s entrance sound is **vine boom**.");
    assert.equal(await say("!entrance <@!999> AIRHORN"), "<@999>'s entrance sound is now **airhorn**.");
    assert.equal(await say("!entrance <@999> !clear"), "Cleared <@999>'s entrance sound.");
    assert.equal(repo.entrance("999"), undefined);
    assert.equal(repo.entrance("u1"), undefined, "the caller's own entrance is untouched");
  }
});

test("!entrance: a bare mention or @everyone explains the syntax; permission is not required for that", async () => {
  const { send } = await setup();
  const help =
    "To manage another user's entrance sound, mention them with a sound or `!clear`, e.g. `!entrance @User sound-name` (requires Manage Server permission).";
  for (const t of ["!entrance @everyone", "!entrance @here", "!entrance <@&55>"]) {
    assert.deepEqual((await send(t)).replies, [{ content: help, noMentions: true }], t);
  }
});

test("!entrance without a repository degrades gracefully before checking permissions", async () => {
  const { send } = await setup({ withRepo: false });
  for (const t of ["!entrance", "!entrance vine boom", "!entrance <@999> vine boom", "!RM-entrance"]) {
    assert.deepEqual((await send(t)).replies, [{ content: "Entrance sounds are not available right now.", noMentions: true }], t);
  }
});

// ───────────────────────────── !import ─────────────────────────────

test("!import: disabled service, usage and not-ready replies", async () => {
  const off = await setup({ importer: null });
  assert.deepEqual((await off.send("!import https://x.test/v")).replies, [
    { content: "The YouTube import service is disabled on this server.", noMentions: false },
  ]);
  assert.deepEqual((await off.send("!import")).replies, [
    { content: "The YouTube import service is disabled on this server.", noMentions: false },
  ]);

  const on = await setup();
  const usage = { content: "Usage: `!import <YouTube URL> [from <start> to <end>]`", noMentions: false };
  assert.deepEqual((await on.send("!import")).replies, [usage]);
  assert.deepEqual((await on.send("!import a b c")).replies, [usage]);

  const down = await setup({ importer: { status: async () => ({ ready: false, problem: "ffmpeg not found" }) } });
  assert.deepEqual((await down.send("!import https://x.test/v")).replies, [
    { content: "Import service is not ready: ffmpeg not found", noMentions: false },
  ]);
  const unknown = await setup({ importer: { status: async () => ({ ready: false }) } });
  assert.deepEqual((await unknown.send("!import https://x.test/v")).replies, [
    { content: "Import service is not ready: Unknown error", noMentions: false },
  ]);
});

test("!import: downloads, saves under the suggested name, refreshes the library and edits the progress message", async () => {
  const t = await setup();
  const s = await t.send("!import https://x.test/v");
  assert.deepEqual(s.replies, [{ content: "⏳ Downloading and processing audio from YouTube...", noMentions: false }]);
  assert.deepEqual(s.edits, ['✅ Successfully imported and saved sound: **`clip`**! Play it using `!sound "clip"`']);
  assert.deepEqual(t.importCalls.urls, ["https://x.test/v"]);
  assert.deepEqual(t.importCalls.process, []);
  assert.deepEqual(t.importCalls.save, [["s1", "clip"]]);
  assert.equal(t.invalidated(), 1);
});

test("!import: a valid range is processed; an invalid range is silently ignored", async () => {
  const t = await setup();
  await t.send("!import https://x.test/v from 1:00 to 1:30");
  assert.deepEqual(t.importCalls.process, [["s1", { mode: "range", start: 60, end: 90 }]]);
  await t.send("!import https://x.test/v from 30 to 10");
  await t.send("!import https://x.test/v from abc to 10");
  assert.equal(t.importCalls.process.length, 1);
  assert.equal(t.importCalls.save.length, 3);
});

test("!import: name collisions get a numeric suffix, empty suggestions fall back to youtube_sound", async () => {
  const taken = await setup({ names: ["clip", "clip_1"] });
  assert.match((await taken.send("!import https://x.test/v")).edits[0]!, /\*\*`clip_2`\*\*/);
  assert.deepEqual(taken.importCalls.save, [["s1", "clip_2"]]);

  const blank = await setup({ importer: { importYouTube: async () => ({ id: "s9", suggestedName: "" }) } });
  await blank.send("!import https://x.test/v");
  assert.deepEqual(blank.importCalls.save, [["s9", "youtube_sound"]]);
});

test("!import: failures edit the progress message instead of throwing", async () => {
  const boom = await setup({
    importer: {
      importYouTube: async () => {
        throw new Error("video unavailable");
      },
    },
  });
  const s = await boom.send("!import https://x.test/v");
  assert.deepEqual(s.edits, ["❌ Import failed: video unavailable"]);
  assert.equal(boom.invalidated(), 0);

  const odd = await setup({
    importer: {
      save: async () => {
        throw "not an Error";
      },
    },
  });
  assert.deepEqual((await odd.send("!import https://x.test/v")).edits, ["❌ Import failed: Unknown error occurred."]);
});
