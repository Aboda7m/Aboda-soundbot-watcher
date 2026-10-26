import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { PermissionFlagsBits } from "discord.js";
import { handleEntranceRoute } from "./entranceRoutes.ts";

const ownerId = "111111111111111";
const adminId = "222222222222222";
const targetId = "333333333333333";
const guildAId = "444444444444444";
const guildBId = "555555555555555";

function harness(opts: { guildAAdmin?: boolean; guildBAdmin?: boolean } = {}) {
  const writes: Array<{ userId: string; sound: string }> = [];
  const clears: string[] = [];
  const makeMember = (id: string, admin: boolean) => ({
    id, displayName: id, user: { id, username: id, bot: false },
    permissions: { has: (permission: bigint) =>
      admin && (permission === PermissionFlagsBits.ManageGuild || permission === PermissionFlagsBits.Administrator) },
  });
  const makeGuild = (id: string, admin: boolean) => {
    const adminMember = makeMember(adminId, admin);
    const target = makeMember(targetId, false);
    const members = new Map([[adminId, adminMember], [targetId, target]]);
    return {
      id, name: id, available: true, ownerId,
      members: {
        cache: members,
        fetch: async (arg?: unknown) => {
          if (arg === undefined) return members;
          const userId = typeof arg === "string" ? arg : (arg as { user?: string }).user;
          const member = members.get(userId ?? "");
          if (!member) throw new Error("Unknown Member");
          return member;
        },
      },
    };
  };
  const guildA = makeGuild(guildAId, !!opts.guildAAdmin);
  const guildB = makeGuild(guildBId, !!opts.guildBAdmin);
  const d: any = {
    client: { guilds: { cache: new Map([[guildAId, guildA], [guildBId, guildB]]) } },
    library: { has: (name: string) => name === "sound-one", resolve: () => null },
    repo: {
      entrance: () => undefined,
      setEntrance: (userId: string, sound: string) => writes.push({ userId, sound }),
      clearEntrance: (userId: string) => { clears.push(userId); return true; },
      setGuildEntrance: (_guildId: string, userId: string, sound: string) => writes.push({ userId, sound }),
      clearGuildEntrance: (_guildId: string, userId: string) => { clears.push(userId); return true; },
      hasGuildEntranceOverride: () => false,
    },
  };
  const res: any = {
    status: 0, body: "", headers: {},
    writeHead(status: number, headers: Record<string, string> = {}) { this.status = status; this.headers = headers; return this; },
    end(body = "") { this.body = String(body); this.writableEnded = true; return this; },
  };
  const kit: any = { user: { id: adminId, username: "admin" }, guard: () => true };
  return { d, res, kit, writes, clears };
}
function post(body: unknown) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST" });
}

test("a user without guild permissions cannot assign another member's entrance sound", async () => {
  const h = harness();
  await handleEntranceRoute(h.d, post({ guildId: guildAId, userId: targetId, sound: "sound-one" }) as any,
    h.res, new URL("http://local/api/entrance/admin/assign"), h.kit);
  assert.equal(h.res.status, 403);
  assert.deepEqual(h.writes, []);
});

test("an administrator in Guild A cannot administer a member in Guild B", async () => {
  const h = harness({ guildAAdmin: true, guildBAdmin: false });
  await handleEntranceRoute(h.d, post({ guildId: guildBId, userId: targetId, sound: "sound-one" }) as any,
    h.res, new URL("http://local/api/entrance/admin/assign"), h.kit);
  assert.equal(h.res.status, 403);
  assert.deepEqual(h.writes, []);
});

test("Manage Server can assign a sound to a member of the same guild", async () => {
  const h = harness({ guildAAdmin: true });
  await handleEntranceRoute(h.d, post({ guildId: guildAId, userId: targetId, sound: "sound-one" }) as any,
    h.res, new URL("http://local/api/entrance/admin/assign"), h.kit);
  assert.equal(h.res.status, 200);
  assert.deepEqual(h.writes, [{ userId: targetId, sound: "sound-one" }]);
});

test("personal entrance assignment still targets only the signed-in account", async () => {
  const h = harness();
  await handleEntranceRoute(h.d, post({ userId: targetId, sound: "sound-one" }) as any,
    h.res, new URL("http://local/api/entrance"), h.kit);
  assert.equal(h.res.status, 200);
  assert.deepEqual(h.writes, [{ userId: adminId, sound: "sound-one" }]);
});
