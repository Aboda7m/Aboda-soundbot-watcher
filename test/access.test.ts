import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessPolicy, CAPABILITIES } from "../src/access/AccessPolicy.ts";

const OWNER = "100000000000000001", U1 = "100000000000000002", U2 = "100000000000000003";
const G1 = "200000000000000001", G2 = "200000000000000002";
const file = () => join(mkdtempSync(join(tmpdir(), "access-")), "access.json");

test("default policy: the bot is global and nobody has privileges except owners", () => {
  const a = AccessPolicy.inMemory([OWNER]);
  assert.equal(a.canUseBot(G1, U1), true);
  assert.equal(a.guildAllowed(G1), true);
  for (const cap of CAPABILITIES) {
    assert.equal(a.can(U1, cap), false, cap);
    assert.equal(a.can(OWNER, cap), true, cap);
  }
});

test("whitelist: allowed server OR allowed user; independent of the blacklist switch", () => {
  const a = AccessPolicy.inMemory([OWNER]);
  a.allowGuild(G1);
  assert.equal(a.canUseBot(G2, U1), true, "listing alone enforces nothing while the whitelist is off");
  a.setWhitelist(true);
  assert.equal(a.canUseBot(G1, U1), true);
  assert.equal(a.canUseBot(G2, U1), false);
  assert.equal(a.guildAllowed(G2), false);
  a.allowUser(U1);
  assert.equal(a.canUseBot(G2, U1), true, "an allowed user works anywhere");
  assert.equal(a.guildAllowed(G2), false, "...but the server itself is still not allowed (dashboard targets)");
  assert.equal(a.canUseBot(G2, OWNER), true);
  a.unallowUser(U1);
  assert.equal(a.canUseBot(G2, U1), false);
  a.setWhitelist(false);
  assert.equal(a.canUseBot(G2, U1), true);
});

test("blacklist: blocked users and servers are refused only while it is on; owners can never be blocked", () => {
  const a = AccessPolicy.inMemory([OWNER]);
  a.blockUser(U1);
  a.blockGuild(G2);
  assert.equal(a.canUseBot(G2, U1), true);
  assert.equal(a.isBlocked(U1), false);
  a.setBlacklist(true);
  assert.equal(a.canUseBot(G1, U1), false);
  assert.equal(a.canUseBot(G2, U2), false);
  assert.equal(a.canUseBot(G1, U2), true);
  assert.equal(a.isBlocked(U1), true);
  assert.equal(a.guildAllowed(G2), false);
  assert.equal(a.blockUser(OWNER), false);
  assert.equal(a.canUseBot(G2, OWNER), true);
  a.unblockUser(U1);
  assert.equal(a.canUseBot(G1, U1), true);
});

test("blacklist beats the whitelist and beats grants", () => {
  const a = AccessPolicy.inMemory([OWNER]);
  a.setWhitelist(true); a.setBlacklist(true);
  a.allowUser(U1); a.blockUser(U1); a.grant(U1, "import");
  assert.equal(a.canUseBot(G1, U1), false);
  assert.equal(a.can(U1, "import"), false, "a blocked user loses every permission");
  a.unblockUser(U1);
  assert.equal(a.can(U1, "import"), true);
});

test("grants are per user and per permission, and revoking removes them", () => {
  const a = AccessPolicy.inMemory([OWNER]);
  a.grant(U1, "import");
  a.grant(U1, "import"); // idempotent
  assert.deepEqual(a.snapshot().grants, { [U1]: ["import"] });
  assert.equal(a.can(U1, "import"), true);
  assert.equal(a.can(U1, "entrance.manage"), false);
  assert.equal(a.can(U2, "import"), false);
  a.grant(U1, "logs");
  a.revoke(U1, "import");
  assert.deepEqual(a.snapshot().grants, { [U1]: ["logs"] });
  a.revoke(U1, "logs");
  assert.deepEqual(a.snapshot().grants, {});
});

test("ids are validated (usernames and junk are never stored)", () => {
  const a = AccessPolicy.inMemory([OWNER]);
  for (const bad of ["alice", "123", "<@1>", "", "1".repeat(40)]) {
    assert.throws(() => a.grant(bad, "import"), /valid Discord id/);
    assert.throws(() => a.allowGuild(bad), /valid Discord id/);
  }
});

test("the policy persists across restarts and picks up hand edits without one", () => {
  const p = file();
  const a = new AccessPolicy(p, { owners: [OWNER] });
  a.setWhitelist(true); a.allowGuild(G1); a.grant(U1, "import"); a.blockUser(U2);
  const b = new AccessPolicy(p, { owners: [OWNER] });
  assert.deepEqual(b.snapshot().allowedGuilds, [G1]);
  assert.equal(b.snapshot().whitelistEnabled, true);
  assert.equal(b.can(U1, "import"), true);

  // edit the file by hand while "running"
  const hand = JSON.parse(readFileSync(p, "utf8"));
  hand.whitelistEnabled = false;
  hand.grants = {};
  writeFileSync(p, JSON.stringify(hand));
  const later = new Date(Date.now() + 5000);
  utimesSync(p, later, later);
  const c = new AccessPolicy(p, { owners: [OWNER], reloadCheckMs: 0 });
  c.setBlacklist(true); // any change re-reads first, so the hand edit is not overwritten
  assert.equal(c.snapshot().whitelistEnabled, false);
  assert.equal(c.can(U1, "import"), false);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).blacklistEnabled, true);
});

test("a malformed file is refused at startup, and a file broken while running keeps the last good rules", () => {
  const bad = file();
  for (const content of ["{nope", '{"allowedUsers":["alice"]}', '{"grants":{"100000000000000002":["root"]}}', '{"whitelistEnabled":"yes"}', "[]"]) {
    writeFileSync(bad, content);
    assert.throws(() => new AccessPolicy(bad, { owners: [] }), /access-.*access\.json/s, content);
  }

  const p = file();
  const logs: string[] = [];
  const a = new AccessPolicy(p, { owners: [OWNER], reloadCheckMs: 0, log: (m) => void logs.push(m) });
  a.setWhitelist(true);
  writeFileSync(p, "{broken");
  const later = new Date(Date.now() + 5000);
  utimesSync(p, later, later);
  assert.equal(a.canUseBot(G1, U1), false, "still the previous (whitelist on) rules");
  assert.ok(logs.some((l) => /invalid/.test(l)));
});

test("a missing file means defaults, and the file is created on the first change", () => {
  const p = file();
  const a = new AccessPolicy(p, { owners: [] });
  assert.equal(a.canUseBot(G1, U1), true);
  a.allowUser(U1);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).allowedUsers, [U1]);
});

const bump = (p: string, secs = 5) => {
  const t = new Date(Date.now() + secs * 1000);
  utimesSync(p, t, t);
};

const DEFAULT_FILE = {
  version: 1,
  whitelistEnabled: false,
  blacklistEnabled: false,
  allowedGuilds: [],
  allowedUsers: [],
  blockedGuilds: [],
  blockedUsers: [],
  grants: {},
};

test("a missing access.json is created at startup with the open defaults (and nested folders)", () => {
  const p = join(mkdtempSync(join(tmpdir(), "access-")), "data", "access.json");
  const a = new AccessPolicy(p, { owners: [OWNER] });
  assert.ok(existsSync(p), "created without any change being made");
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), DEFAULT_FILE);
  assert.equal(a.canUseBot(G1, U1), true);
  assert.equal(a.guildAllowed(G1), true);
  // no credentials or owner ids belong in this file
  assert.doesNotMatch(readFileSync(p, "utf8"), /token|secret|owner|key/i);
  // a restart reads it back unchanged
  const b = new AccessPolicy(p, { owners: [OWNER] });
  assert.deepEqual(b.snapshot().grants, {});
  assert.equal(b.snapshot().whitelistEnabled, false);
});

test("an existing valid file is never replaced by the defaults at startup", () => {
  const p = file();
  writeFileSync(p, JSON.stringify({ ...DEFAULT_FILE, whitelistEnabled: true, allowedUsers: [U1], grants: { [U2]: ["logs"] } }));
  const a = new AccessPolicy(p, { owners: [OWNER] });
  assert.equal(a.snapshot().whitelistEnabled, true);
  assert.equal(a.can(U2, "logs"), true);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).allowedUsers[0], U1);
});

test("empty, missing or partly filled lists never switch whitelist mode on", () => {
  for (const content of ["{}", JSON.stringify({ allowedGuilds: [], allowedUsers: [] }), JSON.stringify({ allowedUsers: [U1], allowedGuilds: [G1] }), JSON.stringify({ version: 1, blacklistEnabled: true })]) {
    const p = file();
    writeFileSync(p, content);
    const a = new AccessPolicy(p, { owners: [OWNER] });
    assert.equal(a.snapshot().whitelistEnabled, false, content);
    assert.equal(a.canUseBot(G2, U2), true, content);
    assert.equal(a.guildAllowed(G2), true, content);
  }
});

test("whitelist enabled explicitly with empty lists admits owners only; owners stay separate from grants", () => {
  const a = AccessPolicy.inMemory([OWNER]);
  a.setWhitelist(true);
  assert.equal(a.canUseBot(G1, U1), false);
  assert.equal(a.canUseBot(G1, OWNER), true);
  assert.equal(a.guildAllowed(G1), false);
  assert.equal(a.guildAllowed(G1, OWNER), true, "owners reach any dashboard target");
  assert.equal(a.guildAllowed(G1, U1), false);
  a.setBlacklist(true);
  a.blockGuild(G1);
  assert.equal(a.guildAllowed(G1, OWNER), true, "...even a blocked server");
  assert.equal(a.canUseBot(G1, OWNER), true);
  assert.deepEqual(a.snapshot().grants, {}, "owners are not stored as grants");
  assert.equal(a.isOwner(U1), false);
  a.grant(U1, "dashboard");
  assert.equal(a.isOwner(U1), false, "a grant never makes an owner");
  assert.equal(a.can(U1, "import"), false);
});

test("legacy dashboard users (DASHBOARD_ALLOWED_USER_IDS) get the dashboard only: not owners, not persisted", () => {
  const p = file();
  const a = new AccessPolicy(p, { owners: [OWNER], dashboardUsers: [U1] });
  assert.equal(a.isOwner(U1), false);
  assert.equal(a.can(U1, "dashboard"), true);
  for (const cap of CAPABILITIES.filter((c) => c !== "dashboard")) assert.equal(a.can(U1, cap), false, cap);
  assert.deepEqual(a.snapshot().owners, [OWNER]);
  assert.deepEqual(a.snapshot().dashboardUsers, [U1]);
  // bot access follows the normal rules (they are not exempt from whitelist/blacklist)
  a.setWhitelist(true);
  assert.equal(a.canUseBot(G1, U1), false);
  // a blocked legacy user loses even the dashboard
  a.setBlacklist(true);
  a.blockUser(U1);
  assert.equal(a.can(U1, "dashboard"), false);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).grants, {}, "never copied into access.json");
  assert.equal(JSON.parse(readFileSync(p, "utf8")).dashboardUsers, undefined);
});

test("a file that becomes invalid while running is never overwritten; changes are refused until it is fixed", () => {
  const p = file();
  const logs: string[] = [];
  const a = new AccessPolicy(p, { owners: [OWNER], reloadCheckMs: 0, log: (m) => void logs.push(m) });
  a.grant(U1, "import");
  a.setWhitelist(true);

  writeFileSync(p, '{"whitelistEnabled": tru'); // a hand edit in progress
  bump(p);
  assert.equal(a.can(U1, "import"), true, "last good grants stay in force");
  assert.equal(a.canUseBot(G1, U2), false, "last good whitelist stays in force");
  assert.throws(() => a.grant(U2, "logs"), /not valid.*left alone/s);
  assert.throws(() => a.setBlacklist(true), /not valid/);
  assert.equal(readFileSync(p, "utf8"), '{"whitelistEnabled": tru', "the broken file was not touched");

  // fixed by hand: the edit is picked up, nothing from before is lost, and changes work again
  writeFileSync(p, JSON.stringify({ ...DEFAULT_FILE, grants: { [U1]: ["import"], [U2]: ["entrance.manage"] } }));
  bump(p, 10);
  a.grant(U2, "logs");
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).grants, { [U1]: ["import"], [U2]: ["entrance.manage", "logs"] });
  assert.ok(logs.some((l) => /invalid/.test(l)));
});

test("a deleted file is recreated from the running rules on the next change", () => {
  const p = file();
  const a = new AccessPolicy(p, { owners: [OWNER], reloadCheckMs: 0 });
  a.grant(U1, "import");
  rmSync(p);
  assert.equal(a.can(U1, "import"), true);
  a.allowUser(U2);
  const saved = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(saved.grants, { [U1]: ["import"] });
  assert.deepEqual(saved.allowedUsers, [U2]);
});

test("an `owners` key in access.json grants nothing and is reported", () => {
  const p = file();
  const logs: string[] = [];
  writeFileSync(p, JSON.stringify({ ...DEFAULT_FILE, owners: [U1] }));
  const a = new AccessPolicy(p, { owners: [OWNER], log: (m) => void logs.push(m) });
  assert.equal(a.isOwner(U1), false);
  assert.equal(a.can(U1, "import"), false);
  assert.ok(logs.some((l) => /OWNER_USER_IDS/.test(l)));
});
