import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLogRoute } from "../src/http/logRoutes.ts";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

const sound = (n: number, extra: Record<string, unknown> = {}) => ({
  timestamp: new Date(Date.UTC(2026, 9, 24, 13, 0, n)).toISOString(),
  sound: `s${n}`,
  guildId: "571794276330110986",
  channelId: "571794276330110992",
  source: "entrance",
  trigger: "auto-entrance",
  userId: "369440647507083264",
  username: "eng.aboda7m",
  ...extra,
});

async function withServer(
  setup: (dir: string) => Promise<void>,
  body: (get: (qs: string) => Promise<{ status: number; data: any }>, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "logroutes-"));
  await setup(dir);
  const logs = { soundPlayFile: join(dir, "sound.json"), voiceActivityFile: join(dir, "voice.json") };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (!(await handleLogRoute(logs, req, res, url, { json }))) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const get = async (qs: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/logs?${qs}`);
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await body(get, dir);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}

test("returns the newest entries oldest-first, and pages backwards and forwards", async () => {
  const all = Array.from({ length: 10 }, (_, i) => sound(i));
  await withServer(
    (dir) => writeFile(join(dir, "sound.json"), JSON.stringify(all, null, 2)),
    async (get, dir) => {
      let r = await get("type=sound&limit=4");
      assert.equal(r.status, 200);
      assert.equal(r.data.total, 10);
      assert.equal(r.data.start, 6);
      assert.deepEqual(r.data.entries.map((e: any) => e.sound), ["s6", "s7", "s8", "s9"]);

      r = await get("type=sound&before=6&limit=4");
      assert.equal(r.data.start, 2);
      assert.deepEqual(r.data.entries.map((e: any) => e.sound), ["s2", "s3", "s4", "s5"]);

      r = await get("type=sound&before=2&limit=4");
      assert.equal(r.data.start, 0);
      assert.deepEqual(r.data.entries.map((e: any) => e.sound), ["s0", "s1"]);

      // New entries appear when the file grows (size changes, so the cache is refreshed).
      await writeFile(join(dir, "sound.json"), JSON.stringify([...all, sound(10), sound(11)], null, 2));
      r = await get("type=sound&from=10&limit=50");
      assert.equal(r.data.total, 12);
      assert.deepEqual(r.data.entries.map((e: any) => e.sound), ["s10", "s11"]);

      // Asking past the end reports the (smaller) total so the page knows the file was cut down.
      await writeFile(join(dir, "sound.json"), JSON.stringify(all.slice(0, 3)));
      r = await get("type=sound&from=10");
      assert.equal(r.data.total, 3);
      assert.deepEqual(r.data.entries, []);
    },
  );
});

test("keeps only known fields and leaves timestamps untouched (UTC)", async () => {
  await withServer(
    (dir) =>
      writeFile(
        join(dir, "voice.json"),
        JSON.stringify([
          {
            timestamp: "2026-10-24T13:58:18.527Z",
            action: "DISCONNECT",
            userId: "369440647507083264",
            username: "eng.aboda7m",
            guildName: "another emote server",
            channelName: null,
            previousChannelName: "General",
            secret: "do not send",
          },
          "not an entry",
          7,
        ]),
      ),
    async (get) => {
      const r = await get("type=voice");
      assert.equal(r.data.total, 1);
      assert.equal(r.data.skipped, 2);
      assert.deepEqual(r.data.entries[0], {
        timestamp: "2026-10-24T13:58:18.527Z",
        action: "DISCONNECT",
        userId: "369440647507083264",
        username: "eng.aboda7m",
        guildName: "another emote server",
        channelName: null,
        previousChannelName: "General",
      });
    },
  );
});

test("a missing file is an empty log, a damaged file is salvaged", async () => {
  await withServer(
    (dir) =>
      writeFile(
        join(dir, "sound.json"),
        // Cut off mid-write: the last entry is incomplete.
        `[\n${JSON.stringify(sound(1))},\n${JSON.stringify(sound(2))},\n{"timestamp": "2026-10-24T13:0`,
      ),
    async (get) => {
      const voice = await get("type=voice");
      assert.equal(voice.status, 200);
      assert.equal(voice.data.total, 0);

      const snd = await get("type=sound");
      assert.equal(snd.status, 200);
      assert.deepEqual(snd.data.entries.map((e: any) => e.sound), ["s1", "s2"]);
    },
  );
});

test("rejects bad parameters", async () => {
  await withServer(
    async () => {},
    async (get) => {
      for (const qs of [
        "",
        "type=nope",
        "type=sound&limit=0",
        "type=sound&limit=5001",
        "type=sound&limit=abc",
        "type=sound&before=-1",
        "type=sound&before=1&from=1",
      ]) {
        assert.equal((await get(qs)).status, 400, qs);
      }
    },
  );
});
