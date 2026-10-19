import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoundLibrary } from "../src/sound/SoundLibrary.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "sounds-"));

test("lists accepted files, keeps dots in names, ignores others", () => {
  const dir = fresh();
  for (const f of ["airhorn.mp3", "my.sound.wav", "notes.txt", ".hidden.mp3", "UPPER.MP3"]) writeFileSync(join(dir, f), "x");
  mkdirSync(join(dir, "folder.mp3"));
  const lib = new SoundLibrary(dir, [".mp3", ".wav"]);
  assert.deepEqual(lib.list(), ["airhorn", "my.sound", "UPPER"]);
});

test("resolve only returns scanned files: traversal and unknown names give null", () => {
  const dir = fresh();
  writeFileSync(join(dir, "ok.mp3"), "x");
  const lib = new SoundLibrary(dir, [".mp3"]);
  assert.equal(lib.resolve("ok"), join(dir, "ok.mp3"));
  for (const bad of ["../ok", "..\\ok", "/etc/passwd", "ok.mp3", "", "nope"]) assert.equal(lib.resolve(bad), null, bad);
});

test("same name with two extensions: first listed extension wins", () => {
  const dir = fresh();
  writeFileSync(join(dir, "dup.wav"), "x");
  writeFileSync(join(dir, "dup.mp3"), "x");
  assert.equal(new SoundLibrary(dir, [".mp3", ".wav"]).resolve("dup"), join(dir, "dup.mp3"));
  assert.equal(new SoundLibrary(dir, [".wav", ".mp3"]).resolve("dup"), join(dir, "dup.wav"));
});

test("picks up added files without restart", () => {
  const dir = fresh();
  const lib = new SoundLibrary(dir, [".mp3"]);
  assert.deepEqual(lib.list(), []);
  writeFileSync(join(dir, "new.mp3"), "x");
  const t = new Date(Date.now() + 5000); // guarantee a distinct directory mtime
  utimesSync(dir, t, t);
  assert.deepEqual(lib.list(), ["new"]);
});

test("missing folder is an empty library, not a crash", () => {
  const lib = new SoundLibrary(join(tmpdir(), "does-not-exist-xyz"), [".mp3"]);
  assert.deepEqual(lib.list(), []);
  assert.equal(lib.has("a"), false);
});
