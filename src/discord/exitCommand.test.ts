import test from "node:test";
import assert from "node:assert/strict";
import { parseExitCommand } from "./textCommand.ts";

test("!exit shows", () => assert.deepEqual(parseExitCommand("!exit"), { kind: "exit-show" }));
test("!exit <sound> sets", () => assert.deepEqual(parseExitCommand("!exit air horn"), { kind: "exit-set", name: "air horn" }));
test("quotes are stripped", () => assert.deepEqual(parseExitCommand('!exit "air horn"'), { kind: "exit-set", name: "air horn" }));
test("!exit !clear clears (case-insensitive)", () => {
  assert.deepEqual(parseExitCommand("!exit !clear"), { kind: "exit-clear" });
  assert.deepEqual(parseExitCommand("!EXIT !CLEAR"), { kind: "exit-clear" });
});
test("custom prefix", () => assert.deepEqual(parseExitCommand("?exit ?clear", "?"), { kind: "exit-clear" }));
test("other commands are not matched", () => {
  assert.equal(parseExitCommand("!exits"), null);
  assert.equal(parseExitCommand("!entrance x"), null);
  assert.equal(parseExitCommand("hello"), null);
});
