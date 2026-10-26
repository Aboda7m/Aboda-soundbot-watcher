import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLogRoute } from "./logRoutes.ts";

test("log API returns only entries for authorized guilds and hides legacy entries without guild IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guild-log-test-"));
  const soundFile = join(dir, "sound.json");
  const voiceFile = join(dir, "voice.json");
  await writeFile(soundFile, JSON.stringify([
    { timestamp: "t1", sound: "a", guildId: "111111111111111" },
    { timestamp: "t2", sound: "b", guildId: "333333333333333" },
  ]));
  await writeFile(voiceFile, JSON.stringify([
    { timestamp: "t1", action: "JOIN", guildId: "111111111111111", guildName: "A" },
    { timestamp: "t2", action: "JOIN", guildName: "legacy without guild ID" },
    { timestamp: "t3", action: "JOIN", guildId: "333333333333333", guildName: "B" },
  ]));

  try {
    for (const [type, expectedCount] of [["sound", 1], ["voice", 1]] as const) {
      const res: any = {
        status: 0,
        body: "",
        writeHead(status: number) { this.status = status; return this; },
        end(body = "") { this.body = String(body); return this; },
      };
      await handleLogRoute(
        { soundPlayFile: soundFile, voiceActivityFile: voiceFile },
        { method: "GET" } as any,
        res,
        new URL(`http://local/api/logs?type=${type}`),
        { json: (_res, status, body) => { res.status = status; res.body = JSON.stringify(body); }, allowedGuildIds: ["111111111111111"] },
      );
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.total, expectedCount);
      assert.equal(body.entries.length, expectedCount);
      assert.equal(body.entries[0].guildId, "111111111111111");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
