import { test } from "node:test";
import assert from "node:assert/strict";
import { editDistance, normalizeSoundQuery, parseSoundCommand, searchSound, similarity } from "../src/discord/textCommand.ts";

// The real examples plus filler so the library is the same size (142) as the production one.
const base = ["bandar", "bandar-fifa", "bdr", "badr3", "badr4", "fifa"];
const filler = Array.from({ length: 136 }, (_, i) => `zork-${String(i).padStart(3, "0")}-quux`);
const names = [...base, ...filler].sort((a, b) => a.localeCompare(b));

const play = (input: string, via?: string) => {
  const r = searchSound(input, names);
  assert.equal(r.kind, "match", `${input} -> ${JSON.stringify(r)}`);
  if (r.kind === "match" && via) assert.equal(r.via, via);
  return r.kind === "match" ? r.name : "";
};

test("existing behaviour is preserved: exact and case-insensitive names, abbreviations, siblings stay distinct", () => {
  assert.equal(names.length, 142);
  assert.equal(play("bdr", "exact"), "bdr");
  assert.equal(play("bandar-fifa", "exact"), "bandar-fifa");
  assert.equal(play("BANDAR-FIFA", "exact"), "bandar-fifa");
  assert.equal(play("bandar", "exact"), "bandar"); // not replaced by bandar-fifa
  assert.equal(play("fifa", "exact"), "fifa"); // not replaced by bandar-fifa
  assert.equal(play("badr3", "exact"), "badr3");
});

test("leading list markers, quotes and spacing are normalized away", () => {
  assert.equal(normalizeSoundQuery("- bandar-fifa"), "bandar-fifa");
  assert.equal(normalizeSoundQuery("• bandar-fifa"), "bandar-fifa");
  assert.equal(normalizeSoundQuery("•bandar-fifa"), "bandar-fifa");
  assert.equal(normalizeSoundQuery("1. bandar-fifa"), "bandar-fifa");
  assert.equal(normalizeSoundQuery('-   "bandar   fifa"'), "bandar fifa");
  assert.equal(normalizeSoundQuery("-bandar"), "-bandar"); // no space: could be part of a name, left alone
  assert.equal(play("- bandar-fifa", "exact"), "bandar-fifa");
  assert.equal(play("• bandar-fifa", "exact"), "bandar-fifa");
  assert.equal(play("- bdr", "exact"), "bdr");
  // end to end through the real command parser, which keeps the "- " in the name it hands over
  const cmd = parseSoundCommand("!sound - bandar-fifa");
  assert.deepEqual(cmd, { kind: "sound", name: "- bandar-fifa" });
  assert.equal(play(cmd!.kind === "sound" ? cmd.name : "", "exact"), "bandar-fifa");
});

test("separators and case are ignored", () => {
  assert.equal(play("bandar fifa", "normalized"), "bandar-fifa");
  assert.equal(play("Bandar_Fifa", "normalized"), "bandar-fifa");
  assert.equal(play("bandarfifa", "normalized"), "bandar-fifa");
});

test("reversed or concatenated word order finds the sound", () => {
  assert.equal(play("fifabandar", "reordered"), "bandar-fifa");
  assert.equal(play("fifa-bandar", "reordered"), "bandar-fifa");
  assert.equal(play("fifa bandar", "reordered"), "bandar-fifa");
  assert.equal(play("- fifabandar", "reordered"), "bandar-fifa");
});

test("a unique partial name plays; several partials are ambiguous, never arbitrary", () => {
  assert.equal(play("bandar-fif", "partial"), "bandar-fifa");
  assert.deepEqual(searchSound("badr", names), { kind: "ambiguous", matches: ["badr3", "badr4"] }); // not bdr
  assert.deepEqual(searchSound("ban", names), { kind: "ambiguous", matches: ["bandar", "bandar-fifa"] });
  assert.deepEqual(searchSound("fif", names), { kind: "ambiguous", matches: ["bandar-fifa", "fifa"] });
});

test("spelling mistakes: close-but-unsure suggests, clearly-closest plays", () => {
  assert.deepEqual(searchSound("bandarfiffia", names), { kind: "suggest", matches: ["bandar-fifa"] }); // sim 0.83 < 0.88
  assert.equal(play("bandarfifx", "fuzzy"), "bandar-fifa"); // one wrong letter, sim 0.90, far ahead of "bandar"
  assert.equal(play("bandar-fifaa", "fuzzy"), "bandar-fifa");
  assert.equal(play("fifabandarr", "fuzzy"), "bandar-fifa"); // typo + reversed order
  assert.deepEqual(searchSound("fifaa", names), { kind: "suggest", matches: ["fifa"] }); // 0.80: suggest only
  assert.deepEqual(searchSound("bdt", names), { kind: "suggest", matches: ["bdr"] }); // short names never auto-fuzzy
});

test("typo with two equally close candidates is not decided arbitrarily", () => {
  const twins = ["bandar-fifa1", "bandar-fifa2", "zzz"];
  assert.deepEqual(searchSound("bandar-fifa3", twins), { kind: "suggest", matches: ["bandar-fifa1", "bandar-fifa2"] });
});

test("incomplete input only suggests", () => {
  assert.deepEqual(searchSound("- bandar-", names), { kind: "suggest", matches: ["bandar", "bandar-fifa"] });
  assert.deepEqual(searchSound("bandar-", names), { kind: "suggest", matches: ["bandar", "bandar-fifa"] });
  assert.deepEqual(searchSound("• bandar-", names), { kind: "suggest", matches: ["bandar", "bandar-fifa"] });
  // "fifa-" starts only "fifa"; "bandar-fifa" merely contains it, so it is listed second
  assert.deepEqual(searchSound("fifa-", names), { kind: "suggest", matches: ["fifa", "bandar-fifa"] });
});

test("no useful match", () => {
  assert.deepEqual(searchSound("qwertyuiop", names), { kind: "none" });
  assert.deepEqual(searchSound("-", names), { kind: "none" });
  assert.deepEqual(searchSound("x", names), { kind: "none" });
  assert.deepEqual(searchSound("", names), { kind: "none" });
  assert.deepEqual(searchSound("anything", []), { kind: "none" });
});

test("names with spaces, punctuation and non-Latin letters still resolve", () => {
  const n = ["it's fine", "wow!! (1)", "air horn", "بندر"];
  assert.equal(searchSound("it's fine", n).kind, "match");
  assert.deepEqual(searchSound("wow!!", n), { kind: "match", name: "wow!! (1)", via: "partial" });
  assert.deepEqual(searchSound("horn air", n), { kind: "match", name: "air horn", via: "reordered" });
  assert.deepEqual(searchSound("بندر", n), { kind: "match", name: "بندر", via: "exact" });
});

test("canonical names are never altered and case-only duplicates stay ambiguous", () => {
  const n = ["Bruh", "bruh", "Bandar-Fifa"];
  assert.deepEqual(searchSound("BRUH", n), { kind: "ambiguous", matches: ["Bruh", "bruh"] });
  assert.deepEqual(searchSound("bandar fifa", n), { kind: "match", name: "Bandar-Fifa", via: "normalized" });
});

test("edit distance / similarity helpers", () => {
  assert.equal(editDistance("bandarfifa", "bandarfiffia"), 2);
  assert.equal(editDistance("ab", "ba"), 1); // transposition counts once
  assert.equal(similarity("abc", "abc"), 1);
  assert.equal(similarity("", ""), 1);
});
