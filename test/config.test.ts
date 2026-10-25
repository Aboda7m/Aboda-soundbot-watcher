import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNetworkConfig, loadConfig } from "../src/config.ts";

const full = {
  PUBLIC_BASE_URL: "https://dash.example.com/",
  DISCORD_CLIENT_ID: "1", DISCORD_CLIENT_SECRET: "s",
  DASHBOARD_ALLOWED_USER_IDS: "111111111111111111, 222222222222222222",
  LOCAL_ACCESS_KEY: "0123456789abcdef0123456789abcdef",
};

test("config: defaults are public 127.0.0.1:3939 and local 127.0.0.1:3940", () => {
  const c = loadConfig(full);
  assert.deepEqual([c.publicHost, c.publicPort, c.localHost, c.localPort], ["127.0.0.1", 3939, "127.0.0.1", 3940]);
  assert.equal(c.sessionRecheckMs, 10 * 60_000);
  assert.equal(c.publicBaseUrl, "https://dash.example.com");
  assert.deepEqual(c.dashboardUserIds, ["111111111111111111", "222222222222222222"]);
  const check = checkNetworkConfig(c);
  assert.deepEqual(check.errors, []);
  assert.deepEqual(check.warnings, []);
});

test("config: owners are OWNER_USER_IDS plus the legacy DASHBOARD_ALLOWED_USER_IDS; the policy file defaults next to the app", () => {
  const c = loadConfig({ OWNER_USER_IDS: "333333333333333333 444444444444444444", DASHBOARD_ALLOWED_USER_IDS: "444444444444444444,555555555555555555" });
  assert.deepEqual(c.ownerUserIds, ["333333333333333333", "444444444444444444", "555555555555555555"]);
  assert.match(c.accessFile, /access\.json$/);
  assert.match(loadConfig({ ACCESS_FILE: "./data/rules.json" }).accessFile, /rules\.json$/);
  assert.match(checkNetworkConfig(loadConfig({})).warnings.join("\n"), /nobody is authorized to sign in.*!access/);
  assert.doesNotMatch(checkNetworkConfig(loadConfig({ OWNER_USER_IDS: "333333333333333333" })).warnings.join("\n"), /nobody is authorized/);
});

test("config: the legacy ACCESS_KEY only ever becomes the LOCAL key", () => {
  const c = loadConfig({ ...full, LOCAL_ACCESS_KEY: undefined, ACCESS_KEY: "old-key-old-key-old-key-1234" });
  assert.equal(c.localAccessKey, "old-key-old-key-old-key-1234");
  assert.equal(c.localKeyIsLegacy, true);
  assert.ok(!("accessKey" in c), "there is no public access-key setting");
  assert.ok(!JSON.stringify({ ...c, localAccessKey: "" }).includes("old-key"));
  assert.match(checkNetworkConfig(c).warnings.join("\n"), /ACCESS_KEY is now used only by the local listener/);
  // an explicit LOCAL_ACCESS_KEY wins
  assert.equal(loadConfig({ ...full, ACCESS_KEY: "old" }).localAccessKey, full.LOCAL_ACCESS_KEY);
});

test("config: the local listener stays off without a key, and can be switched off", () => {
  assert.equal(loadConfig({ ...full, LOCAL_ACCESS_KEY: "" }).localEnabled, false);
  assert.equal(loadConfig({ ...full, LOCAL_ENABLED: "0" }).localEnabled, false);
  assert.equal(loadConfig(full).localEnabled, true);
});

test("config: same port, or a wildcard local bind, refuse to start", () => {
  assert.match(checkNetworkConfig(loadConfig({ ...full, LOCAL_PORT: "3939" })).errors.join(), /different ports/);
  for (const host of ["0.0.0.0", "::", "[::]"]) {
    assert.match(checkNetworkConfig(loadConfig({ ...full, LOCAL_HOST: host })).errors.join(), /EVERY network interface/, host);
  }
  // ...unless that is explicitly asked for, in which case it starts with a loud warning
  const all = checkNetworkConfig(loadConfig({ ...full, LOCAL_HOST: "0.0.0.0", LOCAL_ALLOW_ALL_INTERFACES: "1" }));
  assert.deepEqual(all.errors, []);
  assert.match(all.warnings.join("\n"), /ALL interfaces/);
  assert.equal(loadConfig(full).localDashboard, true);
  assert.equal(loadConfig({ ...full, LOCAL_DASHBOARD: "0" }).localDashboard, false);
  // not an error when the listener is off
  assert.deepEqual(checkNetworkConfig(loadConfig({ ...full, LOCAL_ENABLED: "0", LOCAL_HOST: "0.0.0.0" })).errors, []);
});

test("config: a LAN bind is allowed but warned about; weak keys and open sign-in gaps are flagged", () => {
  const lan = checkNetworkConfig(loadConfig({ ...full, LOCAL_HOST: "192.168.1.20" }));
  assert.deepEqual(lan.errors, []);
  assert.match(lan.warnings.join(), /other devices on that network/);
  assert.match(checkNetworkConfig(loadConfig({ ...full, LOCAL_ACCESS_KEY: "short" })).warnings.join(), /shorter than 16/);
  const bare = checkNetworkConfig(loadConfig({ LOCAL_ACCESS_KEY: full.LOCAL_ACCESS_KEY }));
  assert.match(bare.warnings.join("\n"), /sign-in is not configured/);
  assert.match(bare.warnings.join("\n"), /nobody is authorized/);
  assert.match(checkNetworkConfig(loadConfig({ ...full, PUBLIC_HOST: "0.0.0.0" })).warnings.join(), /public listener is bound/);
  assert.match(checkNetworkConfig(loadConfig({ ...full, PUBLIC_BASE_URL: "https://x.example/path" })).errors.join(), /PUBLIC_BASE_URL/);
  assert.match(checkNetworkConfig(loadConfig({ ...full, PUBLIC_BASE_URL: "http://dash.example.com" })).warnings.join(), /plain http/);
});

test("config: public bind is loopback by default; an old HOST=0.0.0.0 is ignored, PUBLIC_HOST is the deliberate switch", () => {
  const old = loadConfig({ ...full, HOST: "0.0.0.0" });
  assert.equal(old.publicHost, "127.0.0.1");
  assert.equal(old.ignoredLegacyHost, "0.0.0.0");
  assert.match(checkNetworkConfig(old).warnings.join("\n"), /HOST=0\.0\.0\.0 was ignored/);
  assert.equal(loadConfig({ ...full, HOST: "192.168.1.20" }).publicHost, "127.0.0.1");
  // loopback values of the legacy variable are still honored
  assert.equal(loadConfig({ ...full, HOST: "localhost" }).publicHost, "localhost");
  assert.equal(loadConfig({ ...full, HOST: "127.0.0.1" }).ignoredLegacyHost, "");
  // PUBLIC_HOST wins, and widening it is allowed but warned about
  const wide = loadConfig({ ...full, HOST: "127.0.0.1", PUBLIC_HOST: "0.0.0.0" });
  assert.equal(wide.publicHost, "0.0.0.0");
  assert.match(checkNetworkConfig(wide).warnings.join("\n"), /public listener is bound to 0\.0\.0\.0/);
});

test("config: without PUBLIC_BASE_URL the warning explains the HTTP 421 behaviour; recheck can be switched off", () => {
  const c = loadConfig({ LOCAL_ACCESS_KEY: full.LOCAL_ACCESS_KEY });
  assert.match(checkNetworkConfig(c).warnings.join("\n"), /PUBLIC_BASE_URL is not set.*localhost:3939.*421/);
  assert.equal(loadConfig({ SESSION_RECHECK_MINUTES: "0" }).sessionRecheckMs, 0);
});
