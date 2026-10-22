import { test } from "node:test";
import assert from "node:assert/strict";
import { checkName, cleanUploadName, suggestName } from "../src/import/names.ts";

test("suggestName turns file names into valid sound names", () => {
  assert.equal(suggestName("Air Horn.mp3"), "Air Horn");
  assert.equal(suggestName("My Song (final) [v2].wav"), "My Song final v2");
  assert.equal(suggestName("air.horn.v2.ogg"), "air horn v2");
  assert.equal(suggestName("../../etc/passwd.mp3"), "passwd");
  assert.equal(suggestName("C:\\music\\boom.mp3"), "boom");
  assert.equal(suggestName("___.mp3"), "");
  assert.equal(suggestName("con.mp3"), "con clip");
  assert.equal(suggestName("x".repeat(200) + ".mp3").length, 64);
  assert.equal(suggestName("صوت جميل.mp3"), "صوت جميل");
});

test("checkName accepts normal names and rejects anything that could escape or confuse", () => {
  for (const ok of ["airhorn", "Air Horn", "a", "bruh-2", "snake_case", "صوت"]) assert.deepEqual(checkName(ok), { ok: true, name: ok });
  assert.deepEqual(checkName("  padded  "), { ok: true, name: "padded" });
  const bad = ["", "   ", "../x", "a/b", "a\\b", ".hidden", "a.mp3", 'say "hi"', "trail.", "-lead", "_lead", "NUL", "com1", "x".repeat(65), "a\u0000b", "a\nb"];
  for (const b of bad) assert.equal(checkName(b).ok, false, JSON.stringify(b));
  for (const nonString of [null, undefined, 5, {}, ["a"]]) assert.equal(checkName(nonString).ok, false);
});

test("cleanUploadName strips directories and control characters", () => {
  assert.equal(cleanUploadName("a/b/c.mp3"), "c.mp3");
  assert.equal(cleanUploadName("a\\b\\c.mp3"), "c.mp3");
  assert.equal(cleanUploadName("bad\u0000name.mp3"), "badname.mp3");
});
