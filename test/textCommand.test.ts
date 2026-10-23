import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MESSAGE_CHARS,
  chunkLines,
  escapeMarkdown,
  matchSoundName,
  parseEntranceCommand,
  parseSoundCommand,
  parseSoundListCommand,
  resolveSoundName,
} from "../src/discord/textCommand.ts";

test("parses quoted, unquoted and smart-quoted names", () => {
  assert.deepEqual(parseSoundCommand('!sound "air horn"'), { kind: "sound", name: "air horn" });
  assert.deepEqual(parseSoundCommand("!sound air horn"), { kind: "sound", name: "air horn" });
  assert.deepEqual(parseSoundCommand("!sound “air horn”"), { kind: "sound", name: "air horn" });
  assert.deepEqual(parseSoundCommand("  !SOUND  bruh  "), { kind: "sound", name: "bruh" });
});
test("bare command gives usage; other text is ignored", () => {
  assert.deepEqual(parseSoundCommand("!sound"), { kind: "usage" });
  assert.deepEqual(parseSoundCommand('!sound ""'), { kind: "usage" });
  assert.equal(parseSoundCommand("!soundcheck"), null);
  assert.equal(parseSoundCommand("hello !sound x"), null);
});
test("custom prefix", () => {
  assert.deepEqual(parseSoundCommand("?sound hi", "?"), { kind: "sound", name: "hi" });
  assert.equal(parseSoundCommand("!sound hi", "?"), null);
});
test("matches exact first, then case-insensitively", () => {
  const names = ["Bruh", "bruh", "airhorn"];
  assert.equal(matchSoundName("bruh", names), "bruh");
  assert.equal(matchSoundName("AIRHORN", names), "airhorn");
  assert.equal(matchSoundName("nope", names), null);
});

test("resolveSoundName: exact beats partial, then case-insensitive, then unique partial", () => {
  const names = ["air", "air horn", "airhorn", "Bruh Moment", "vine boom"];
  assert.deepEqual(resolveSoundName("air", names), { kind: "match", name: "air" }); // exact wins over partials
  assert.deepEqual(resolveSoundName("BRUH moment", names), { kind: "match", name: "Bruh Moment" });
  assert.deepEqual(resolveSoundName("boom", names), { kind: "match", name: "vine boom" });
  assert.deepEqual(resolveSoundName("bruh", names), { kind: "match", name: "Bruh Moment" });
});
test("resolveSoundName: several partial matches are never resolved arbitrarily", () => {
  const names = ["air horn", "airhorn", "vine boom"];
  assert.deepEqual(resolveSoundName("hor", names), { kind: "ambiguous", matches: ["air horn", "airhorn"] });
  assert.deepEqual(resolveSoundName("zzz", names), { kind: "none" });
});
test("resolveSoundName: names with spaces and punctuation, and case-only duplicates", () => {
  const names = ["it's fine", "wow!! (1)", "Bruh", "bruh"];
  assert.deepEqual(resolveSoundName("it's fine", names), { kind: "match", name: "it's fine" });
  assert.deepEqual(resolveSoundName("wow!!", names), { kind: "match", name: "wow!! (1)" });
  assert.deepEqual(resolveSoundName("bruh", names), { kind: "match", name: "bruh" }); // exact
  assert.deepEqual(resolveSoundName("BRUH", names), { kind: "ambiguous", matches: ["Bruh", "bruh"] });
});
test("resolveSoundName: allowPartial=false stops at exact / case-insensitive", () => {
  assert.deepEqual(resolveSoundName("hor", ["air horn"], { allowPartial: false }), { kind: "none" });
  assert.deepEqual(resolveSoundName("AIR HORN", ["air horn"], { allowPartial: false }), { kind: "match", name: "air horn" });
});
test("parseSoundListCommand", () => {
  assert.deepEqual(parseSoundListCommand("!soundlist"), { kind: "soundlist" });
  assert.deepEqual(parseSoundListCommand("  !SoundList  "), { kind: "soundlist" });
  assert.equal(parseSoundListCommand("!soundlists"), null);
  assert.equal(parseSoundListCommand("!sound list"), null);
  assert.equal(parseSoundCommand("!soundlist"), null); // !sound never swallows it
});
test("parseEntranceCommand", () => {
  assert.deepEqual(parseEntranceCommand("!entrance"), { kind: "entrance-show" });
  assert.deepEqual(parseEntranceCommand("!entrance air horn"), { kind: "entrance-set", name: "air horn" });
  assert.deepEqual(parseEntranceCommand('!entrance "air horn"'), { kind: "entrance-set", name: "air horn" });
  assert.deepEqual(parseEntranceCommand("!entrance !clear"), { kind: "entrance-clear" });
  assert.deepEqual(parseEntranceCommand("!entrance !CLEAR"), { kind: "entrance-clear" });
  assert.deepEqual(parseEntranceCommand("?entrance ?clear", "?"), { kind: "entrance-clear" });
  assert.deepEqual(parseEntranceCommand("!RM-entrance"), { kind: "entrance-clear" });
  // A user mention targets that user (administrator feature); only role mentions, @everyone and @here
  // are the "explain the syntax" case.
  assert.deepEqual(parseEntranceCommand("!entrance <@123456>"), { kind: "entrance-target-show", targetId: "123456" });
  assert.deepEqual(parseEntranceCommand("!entrance <@!123456>"), { kind: "entrance-target-show", targetId: "123456" });
  assert.deepEqual(parseEntranceCommand('!entrance <@123456> "air horn"'), { kind: "entrance-target-set", targetId: "123456", name: "air horn" });
  assert.deepEqual(parseEntranceCommand("!entrance <@123456> !clear"), { kind: "entrance-target-clear", targetId: "123456" });
  assert.deepEqual(parseEntranceCommand("!entrance <@&123456>"), { kind: "entrance-mention" });
  assert.deepEqual(parseEntranceCommand("!entrance @everyone"), { kind: "entrance-mention" });
  assert.deepEqual(parseEntranceCommand("!entrance @here"), { kind: "entrance-mention" });
  assert.equal(parseEntranceCommand("!entrances"), null);
  assert.equal(parseEntranceCommand("hello !entrance"), null);
});
test("chunkLines keeps every chunk under the limit and loses nothing", () => {
  const lines = Array.from({ length: 600 }, (_, i) => `• sound number ${i}`);
  const chunks = chunkLines(lines, MAX_MESSAGE_CHARS, "header\n");
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= MAX_MESSAGE_CHARS && c.length < 2000);
  assert.equal(chunks.join("\n").replace(/^header\n/, "").split("\n").length, 600);
  assert.deepEqual(chunkLines([]), []);
  const long = chunkLines(["x".repeat(4500)], 1900);
  assert.deepEqual(long.map((c) => c.length), [1900, 1900, 700]);
});
test("escapeMarkdown", () => {
  assert.equal(escapeMarkdown("a_b*c`d"), "a\\_b\\*c\\`d");
});
