import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSoundName, parseSoundCommand } from "../src/discord/textCommand.ts";

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
