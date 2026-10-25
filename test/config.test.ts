import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNetworkConfig, loadConfig } from "../src/config.ts";

const OWNER = "100000000000000001", LEGACY = "100000000000000002";

test("owners come from OWNER_USER_IDS only; legacy DASHBOARD_ALLOWED_USER_IDS stay dashboard-only", () => {
  const c = loadConfig({ OWNER_USER_IDS: OWNER, DASHBOARD_ALLOWED_USER_IDS: `${LEGACY}, ${OWNER}` });
  assert.deepEqual(c.ownerUserIds, [OWNER]);
  assert.deepEqual(c.dashboardUserIds, [LEGACY, OWNER]);
  const legacyOnly = loadConfig({ DASHBOARD_ALLOWED_USER_IDS: LEGACY });
  assert.deepEqual(legacyOnly.ownerUserIds, []);
  assert.ok(checkNetworkConfig(legacyOnly).warnings.some((w) => /no longer treated as owners/.test(w)));
  assert.ok(checkNetworkConfig(legacyOnly).warnings.some((w) => /OWNER_USER_IDS is not set/.test(w)));
});

test("the access file defaults to ./access.json and ACCESS_FILE moves it", () => {
  assert.match(loadConfig({}).accessFile, /access\.json$/);
  assert.match(loadConfig({ ACCESS_FILE: "./data/acl.json" }).accessFile, /acl\.json$/);
});
