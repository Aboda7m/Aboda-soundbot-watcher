import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { OggOpusWriter } from "../recording/OggOpusWriter.ts";
import { json } from "./common.ts";
import { handleRecordingRoute } from "./recordingRoutes.ts";

const G1 = "111111111111111"; // visible to the test user
const G2 = "333333333333333"; // exists on disk, must stay invisible
const ALICE = "444444444444444444";
const BOB = "555555555555555555";

/** A real Ogg/Opus file of `packets` x 20 ms. */
async function makeOgg(path: string, packets: number) {
  await pipeline(Readable.from(Array.from({ length: packets }, () => Buffer.from([1, 2, 3]))), new OggOpusWriter(), createWriteStream(path));
}

async function buildTree() {
  const root = await mkdtemp(join(tmpdir(), "rec-routes-"));
  // 1. well-formed session with manifest + names
  const s1 = join(root, "guilds", G1, "2026", "10", "30", "20261030_140334_7be63d");
  await mkdir(join(s1, "participants"), { recursive: true });
  await makeOgg(join(s1, "participants", `${ALICE}_1.ogg`), 50); // 1.0 s
  await makeOgg(join(s1, "participants", `${ALICE}_2.ogg`), 100); // 2.0 s
  await makeOgg(join(s1, "participants", `${BOB}_1.ogg`), 25); // 0.5 s
  await writeFile(join(s1, "manifest.json"), JSON.stringify({
    sessionId: "20261030_140334_7be63d", guildId: G1, channelId: "222222222222222", initiatedBy: ALICE,
    guildName: "Test Guild", channelName: "General", initiatedByName: "Alice",
    startedAt: "2026-10-30T14:03:34.000Z", endedAt: "2026-10-30T14:05:34.000Z", durationSeconds: 120, status: "completed",
    outputs: { participants: [
      { userId: ALICE, file: `participants/${ALICE}_1.ogg`, startedAt: "2026-10-30T14:03:40.000Z", username: "Alice" },
      { userId: ALICE, file: `participants/${ALICE}_2.ogg`, startedAt: "2026-10-30T14:04:10.000Z", username: "Alice" },
      { userId: BOB, file: `participants/${BOB}_1.ogg`, startedAt: "2026-10-30T14:03:55.000Z" },
    ] },
  }));
  // 2. older session, oddly nested, NO manifest (names must come from the voice log)
  const s2 = join(root, "guilds", G1, "misc", "old stuff", "20261029_010101_aaaaaa", "participants");
  await mkdir(s2, { recursive: true });
  await makeOgg(join(s2, `${BOB}_1.ogg`), 10);
  await writeFile(join(s2, "notes.txt"), "not audio");
  await writeFile(join(s2, "my voice.ogg"), "unsafe name, must not be offered");
  // 3. session with a damaged manifest and no audio
  const s3 = join(root, "guilds", G1, "2026", "10", "28", "20261028_090000_bbbbbb");
  await mkdir(s3, { recursive: true });
  await writeFile(join(s3, "manifest.json"), "{ this is not json");
  // (deliberately NOT backdated: a damaged/missing manifest must never be reported as a live recording)
  // 3b. copied/restored folder: no manifest, file times are "now" although the session is days old
  const s3b = join(root, "guilds", G1, "2026", "10", "27", "20261027_120000_eeeeee", "participants");
  await mkdir(s3b, { recursive: true });
  await makeOgg(join(s3b, `${ALICE}_1.ogg`), 10);
  // 4. another guild, and a stray folder that is not a snowflake
  const s4 = join(root, "guilds", G2, "2026", "10", "30", "20261030_150000_cccccc", "participants");
  await mkdir(s4, { recursive: true });
  await makeOgg(join(s4, `${ALICE}_1.ogg`), 10);
  await mkdir(join(root, "guilds", "backup", "20261030_150000_dddddd", "participants"), { recursive: true });
  await writeFile(join(root, "voice.json"), JSON.stringify([
    { userId: BOB, username: "BobFromLog", guildId: G1, guildName: "Guild From Log" },
  ]));
  // make the manifest-less session look old/final
  const old = new Date("2026-10-29T01:05:00Z");
  await utimes(join(s2, `${BOB}_1.ogg`), old, old);
  return root;
}

async function withApi(fn: (call: (path: string, init?: RequestInit) => Promise<Response>, root: string) => Promise<void>, allowed: string[] = [G1]) {
  const root = await buildTree();
  const files = { dir: root, voiceActivityFile: join(root, "voice.json") };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (!(await handleRecordingRoute(files, req, res, url, { json, allowedGuildIds: allowed }))) json(res, 404, { error: "no route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn((path, init) => fetch(`http://127.0.0.1:${port}${path}`, init), root);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
}

test("index finds sessions anywhere in a messy tree, newest first, only in allowed guilds", async () => {
  await withApi(async (call) => {
    const body: any = await (await call("/api/recordings")).json();
    assert.deepEqual(body.sessions.map((s: any) => s.id), ["20261030_140334_7be63d", "20261029_010101_aaaaaa", "20261028_090000_bbbbbb", "20261027_120000_eeeeee"]);
    assert.ok(body.sessions.every((s: any) => s.guildId === G1), "the other guild must be invisible");
    assert.equal(body.total, 4);

    const [full, bare, damaged, copied] = body.sessions;
    assert.equal(full.guildName, "Test Guild");
    assert.equal(full.channelName, "General");
    assert.equal(full.status, "completed");
    assert.equal(full.durationSec, 120);
    assert.equal(full.segments, 3);
    assert.deepEqual(full.speakers.map((s: any) => [s.name, s.segments]).sort(), [["Alice", 2], ["BobFromLog", 1]]); // Bob's name: voice log fallback
    assert.equal(full.initiatedBy.name, "Alice");

    assert.equal(bare.guildName, "Guild From Log", "no manifest: name falls back to the voice log");
    assert.equal(bare.segments, 1, "unsafe file name and notes.txt are not offered");
    assert.equal(bare.startedAt, "2026-10-29T01:01:01.000Z", "start time comes from the session folder name");

    assert.equal(damaged.segments, 0);
    assert.equal(damaged.status, "unknown");
    assert.equal(bare.status, "unknown");
    assert.equal(bare.durationSec, 239, "no manifest: length is estimated from when its last audio was written");
    assert.equal(copied.status, "unknown", "a copied folder with fresh file times is not a live recording");
    assert.equal(copied.durationSec, null, "...and gets no invented length");
    assert.equal(copied.endedAt, null);
  });
});

test("session detail has per-segment offsets and real durations read from the Ogg files", async () => {
  await withApi(async (call) => {
    const body: any = await (await call(`/api/recordings/session?guild=${G1}&id=20261030_140334_7be63d`)).json();
    assert.deepEqual(body.tracks.map((t: any) => t.file), [`${ALICE}_1.ogg`, `${BOB}_1.ogg`, `${ALICE}_2.ogg`]); // by time, not by name
    assert.deepEqual(body.tracks.map((t: any) => t.offsetSec), [6, 21, 36]);
    assert.deepEqual(body.tracks.map((t: any) => t.durationSec), [1, 0.5, 2]);
    assert.equal(body.tracks[0].username, "Alice");
    assert.equal(body.tracks[1].username, "BobFromLog");
  });
});

test("another guild's recordings do not exist for this user (detail and audio answer 404)", async () => {
  await withApi(async (call) => {
    assert.equal((await call(`/api/recordings/session?guild=${G2}&id=20261030_150000_cccccc`)).status, 404);
    assert.equal((await call(`/api/recordings/audio?guild=${G2}&id=20261030_150000_cccccc&file=${ALICE}_1.ogg`)).status, 404);
  });
  // ...and with access to nothing, the index is empty
  await withApi(async (call) => {
    const body: any = await (await call("/api/recordings")).json();
    assert.equal(body.total, 0);
  }, []);
});

test("audio: full file, byte ranges, bad ranges, and no way out of the recordings folder", async () => {
  await withApi(async (call) => {
    const base = `/api/recordings/audio?guild=${G1}&id=20261030_140334_7be63d`;
    const whole = await call(`${base}&file=${ALICE}_1.ogg`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "audio/ogg");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    const bytes = Buffer.from(await whole.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "OggS");

    const part = await call(`${base}&file=${ALICE}_1.ogg`, { headers: { Range: "bytes=4-11" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 4-11/${bytes.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(4, 12));

    const tail = await call(`${base}&file=${ALICE}_1.ogg`, { headers: { Range: "bytes=-5" } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(bytes.length - 5));

    assert.equal((await call(`${base}&file=${ALICE}_1.ogg`, { headers: { Range: `bytes=${bytes.length + 10}-` } })).status, 416);

    for (const file of ["../manifest.json", "manifest.json", "..%2F..%2Fvoice.json", `${ALICE}_9.ogg`, "my%20voice.ogg"]) {
      assert.equal((await call(`${base}&file=${file}`)).status, 404, file);
    }
    assert.equal((await call(`/api/recordings/audio?guild=${G1}&id=..&file=${ALICE}_1.ogg`)).status, 404);
    assert.equal((await call(`/api/recordings/audio?guild=abc&id=x&file=y`)).status, 400);

    const dl = await call(`${base}&file=${ALICE}_1.ogg&download=1`);
    assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename="[A-Za-z0-9._-]+\.ogg"$/);
    await dl.arrayBuffer();
  });
});
