import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioReceiveStream, createDefaultAudioReceiveStreamOptions, type VoiceConnection } from "@discordjs/voice";
import { RecordingManager } from "./RecordingManager.ts";

/**
 * A connection whose receiver hands out REAL @discordjs/voice AudioReceiveStreams, because their end-of-stream
 * behaviour (they destroy themselves right after push(null)) is exactly what used to truncate recordings.
 */
function fakeConnection() {
  const speaking = new EventEmitter();
  const streams: AudioReceiveStream[] = [];
  const subscriptions = new Map<string, AudioReceiveStream>();
  const receiver = {
    speaking,
    subscribe(userId: string, options: ConstructorParameters<typeof AudioReceiveStream>[0]) {
      const stream = new AudioReceiveStream({ ...createDefaultAudioReceiveStreamOptions(), ...options });
      stream.once("close", () => subscriptions.delete(userId));
      subscriptions.set(userId, stream);
      streams.push(stream);
      return stream;
    },
  };
  return { connection: { receiver } as unknown as VoiceConnection, speaking, streams };
}

/** Minimal Ogg page reader: one entry per page. */
function readPages(file: Buffer) {
  const pages: { flags: number; packetBytes: number }[] = [];
  let pos = 0;
  while (pos < file.length) {
    assert.equal(file.toString("ascii", pos, pos + 4), "OggS", `bad page header at byte ${pos}`);
    const segments = file[pos + 26]!;
    let size = 0;
    for (let i = 0; i < segments; i++) size += file[pos + 27 + i]!;
    pages.push({ flags: file[pos + 5]!, packetBytes: size });
    pos += 27 + segments + size;
  }
  assert.equal(pos, file.length, "file ends in the middle of a page (truncated)");
  return pages;
}

async function withManager(fn: (m: RecordingManager, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "rec-test-"));
  try {
    await fn(new RecordingManager(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function onlyTrack(sessionDir: string): Promise<Buffer> {
  const files = await readdir(join(sessionDir, "participants"));
  assert.equal(files.length, 1);
  return readFile(join(sessionDir, "participants", files[0]!));
}

const PACKET = Buffer.from([1, 2, 3]); // not the Opus silence frame, so the library treats it as speech
const AUDIO_PAGES = (pages: unknown[]) => pages.length - 2; // minus OpusHead + OpusTags

test("stop keeps every buffered packet and ends the Ogg stream properly", async () => {
  await withManager(async (m) => {
    const { connection, speaking, streams } = fakeConnection();
    const session = (await m.startSession("g1", "c1", "u1", connection))!;
    speaking.emit("start", "42");

    // Pushed back-to-back and stopped immediately: most packets are still queued inside the receive stream.
    for (let i = 0; i < 300; i++) streams[0]!.push(PACKET);
    await m.stopSession("g1");

    const pages = readPages(await onlyTrack(session.sessionDir));
    assert.equal(AUDIO_PAGES(pages), 300, "all 300 packets must reach the file");
    assert.equal(pages.at(-1)!.flags & 0x04, 0x04, "last page must carry the end-of-stream flag");
  });
});

test("stop under disk backpressure (slow disk) still writes every packet queued in the receive stream", async () => {
  await withManager(async (m) => {
    const { connection, speaking, streams } = fakeConnection();
    const session = (await m.startSession("g1", "c1", "u1", connection))!;
    speaking.emit("start", "42");

    // ~150 KB of pages: far more than the file stream accepts at once, so the pipeline pauses the receive stream
    // and most packets are still sitting unread inside it when stop arrives.
    const N = 5000;
    for (let i = 0; i < N; i++) streams[0]!.push(PACKET);
    await m.stopSession("g1");

    const pages = readPages(await onlyTrack(session.sessionDir));
    assert.equal(AUDIO_PAGES(pages), N, "no packet may be dropped when the receive stream is destroyed");
    assert.equal(pages.at(-1)!.flags & 0x04, 0x04);
  });
});

test("the guild stays registered as recording until the files are completely flushed", async () => {
  await withManager(async (m) => {
    const { connection, speaking, streams } = fakeConnection();
    await m.startSession("g1", "c1", "u1", connection);
    speaking.emit("start", "42");
    for (let i = 0; i < 50; i++) streams[0]!.push(PACKET);

    const stopping = m.stopSession("g1");
    assert.equal(m.isRecording("g1"), true, "must still count as recording while flushing (voice cleanup relies on this)");
    await stopping;
    assert.equal(m.isRecording("g1"), false);
  });
});

test("stopping twice at once resolves both calls only after the single flush", async () => {
  await withManager(async (m) => {
    const { connection, speaking, streams } = fakeConnection();
    const session = (await m.startSession("g1", "c1", "u1", connection))!;
    speaking.emit("start", "42");
    for (let i = 0; i < 80; i++) streams[0]!.push(PACKET);

    await Promise.all([m.stopSession("g1"), m.stopSession("g1")]);
    const pages = readPages(await onlyTrack(session.sessionDir));
    assert.equal(AUDIO_PAGES(pages), 80);
    assert.equal(session.status, "SAVED");
  });
});

test("a segment that ends by silence is also closed cleanly (end-of-stream page, nothing lost)", async () => {
  await withManager(async (m) => {
    const { connection, speaking, streams } = fakeConnection();
    const session = (await m.startSession("g1", "c1", "u1", connection))!;
    speaking.emit("start", "42");
    for (let i = 0; i < 120; i++) streams[0]!.push(PACKET);

    await new Promise((r) => setTimeout(r, 1800)); // longer than the 1.5 s silence cut-off, no stop yet
    assert.equal(streams[0]!.destroyed, true, "library ended the stream after silence");

    const pages = readPages(await onlyTrack(session.sessionDir));
    assert.equal(AUDIO_PAGES(pages), 120);
    assert.equal(pages.at(-1)!.flags & 0x04, 0x04);
    await m.stopSession("g1");
  });
});
