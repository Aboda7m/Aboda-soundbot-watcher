import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTrim } from "../src/import/trim.ts";

const L = { defaultSec: 10, maxOutputSec: 600 };
const ok = (r: ReturnType<typeof resolveTrim>) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; plan: import("../src/import/trim.ts").TrimPlan }).plan;
};
const bad = (r: ReturnType<typeof resolveTrim>, re: RegExp) => {
  assert.equal(r.ok, false);
  assert.match((r as { ok: false; error: string }).error, re);
};

test("first N seconds: default trim of long sources, no trim needed for short ones", () => {
  assert.deepEqual(ok(resolveTrim({ mode: "first" }, 3600, L)), { mode: "first", startSec: 0, lengthSec: 10, needsTrim: true });
  assert.deepEqual(ok(resolveTrim({ mode: "first" }, 4, L)), { mode: "first", startSec: 0, lengthSec: 4, needsTrim: false });
  assert.deepEqual(ok(resolveTrim({ mode: "first" }, 10.1, L)), { mode: "first", startSec: 0, lengthSec: 10, needsTrim: false }); // header rounding
  assert.deepEqual(ok(resolveTrim({ mode: "first" }, null, L)), { mode: "first", startSec: 0, lengthSec: 10, needsTrim: true }); // unknown length
});

test("full audio is explicit, keeps everything, and is capped", () => {
  assert.deepEqual(ok(resolveTrim({ mode: "full" }, 120, L)), { mode: "full", startSec: 0, lengthSec: 120, needsTrim: false });
  assert.deepEqual(ok(resolveTrim({ mode: "full" }, null, L)), { mode: "full", startSec: 0, lengthSec: null, needsTrim: false });
  bad(resolveTrim({ mode: "full" }, 601, L), /Full audio is 601 s long.*limit.*600/);
});

test("custom range by end time or by length, validated against the real duration", () => {
  assert.deepEqual(ok(resolveTrim({ mode: "range", start: 5, end: 8 }, 120, L)), { mode: "range", startSec: 5, lengthSec: 3, needsTrim: true });
  assert.deepEqual(ok(resolveTrim({ mode: "range", start: 5, duration: 2.5 }, 120, L)), { mode: "range", startSec: 5, lengthSec: 2.5, needsTrim: true });
  assert.deepEqual(ok(resolveTrim({ mode: "range", end: 4 }, 120, L)), { mode: "range", startSec: 0, lengthSec: 4, needsTrim: true }); // start defaults to 0
  assert.equal(ok(resolveTrim({ mode: "range", start: 0, end: 120 }, 120, L)).needsTrim, false); // the whole file
  assert.equal(ok(resolveTrim({ mode: "range", start: 0, end: 120.1 }, 120, L)).lengthSec, 120); // within rounding tolerance, clamped
  assert.equal(ok(resolveTrim({ mode: "range", start: 100, end: 500 }, null, L)).needsTrim, true); // unknown length: validated after rendering
  bad(resolveTrim({ mode: "range", start: 130, end: 140 }, 120, L), /at or past the end/);
  bad(resolveTrim({ mode: "range", start: 119.95, end: 120 }, 120, L), /at or past the end/);
  bad(resolveTrim({ mode: "range", start: 10, end: 200 }, 120, L), /after the end of the audio/);
  bad(resolveTrim({ mode: "range", start: 10, duration: 500 }, 120, L), /after the end of the audio/);
});

test("invalid ranges are rejected with specific messages", () => {
  bad(resolveTrim({ mode: "range", start: 8, end: 5 }, 120, L), /End time must be after/);
  bad(resolveTrim({ mode: "range", start: 5, end: 5 }, 120, L), /End time must be after/);
  bad(resolveTrim({ mode: "range", start: 5, end: 5.05 }, 120, L), /too short/);
  bad(resolveTrim({ mode: "range", start: -1, end: 5 }, 120, L), /cannot be negative/);
  bad(resolveTrim({ mode: "range", start: "1", end: 5 }, 120, L), /must be a number/);
  bad(resolveTrim({ mode: "range", start: NaN, end: 5 }, 120, L), /must be a number/);
  bad(resolveTrim({ mode: "range", start: 0, end: Infinity }, null, L), /must be a number/);
  bad(resolveTrim({ mode: "range", start: 0 }, 120, L), /end time or a length/);
  bad(resolveTrim({ mode: "range", start: 0, end: 5, duration: 5 }, 120, L), /end time or a length/);
  bad(resolveTrim({ mode: "range", start: 0, end: 700 }, null, L), /limit for a saved sound is 600/);
  bad(resolveTrim({ mode: "banana" }, 120, L), /Trim mode/);
  bad(resolveTrim(null, 120, L), /Trim mode/);
  bad(resolveTrim("first", 120, L), /Trim mode/);
});
