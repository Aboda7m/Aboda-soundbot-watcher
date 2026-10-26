import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthorizer, hasAuthorizationRules } from "../src/http/auth/authorize.ts";
import { createDiscordOAuth } from "../src/http/auth/discordOAuth.ts";

const members: Record<string, { roles: string[] }> = { "300000000000000001": { roles: ["r1"] }, "300000000000000002": { roles: [] } };
const fetchMember = async (_g: string, u: string) => members[u] ?? null;

test("authorize: explicit ids, guild members, role filter; everything else (and errors) refused", async () => {
  const none = createAuthorizer({ userIds: [], roleIds: [], fetchMember });
  assert.equal(await none("300000000000000001"), false);
  assert.equal(hasAuthorizationRules({ userIds: [], guildId: undefined }), false);

  const ids = createAuthorizer({ userIds: ["999999999999999999"], roleIds: [], fetchMember });
  assert.equal(await ids("999999999999999999"), true);
  assert.equal(await ids("300000000000000001"), false);

  const guild = createAuthorizer({ userIds: [], guildId: "g", roleIds: [], fetchMember });
  assert.equal(await guild("300000000000000002"), true);
  assert.equal(await guild("300000000000000009"), false);

  const role = createAuthorizer({ userIds: [], guildId: "g", roleIds: ["r1"], fetchMember });
  assert.equal(await role("300000000000000001"), true);
  assert.equal(await role("300000000000000002"), false);

  const broken = createAuthorizer({ userIds: [], guildId: "g", roleIds: [], fetchMember: async () => { throw new Error("x"); } });
  assert.equal(await broken("300000000000000001"), false); // sign-in fails closed on a lookup error
});

test("authorize: extraAllow adds users, deny beats every allow rule (id list, extra, server)", async () => {
  const a = createAuthorizer({
    userIds: ["999999999999999999"], guildId: "g", roleIds: [], fetchMember,
    extraAllow: (id) => id === "300000000000000009",
    deny: (id) => id === "999999999999999999" || id === "300000000000000001",
  });
  assert.equal(await a("300000000000000009"), true);
  assert.equal(await a("999999999999999999"), false, "an id on the allow list but blocked is refused");
  assert.equal(await a("300000000000000001"), false, "a server member who is blocked is refused");
  assert.equal(await a("300000000000000002"), true, "an ordinary server member is still let in");
  assert.equal(await a.recheck("300000000000000001"), false);
});

test("authorize: anyone sharing a server with the bot may sign in; blocked users and strangers may not; lookup errors fail closed", async () => {
  const shared = new Set(["300000000000000001"]);
  const a = createAuthorizer({ userIds: [], roleIds: [], fetchMember, inBotServer: async (id) => shared.has(id), deny: (id) => id === "300000000000000002" });
  assert.equal(await a("300000000000000001"), true);
  assert.equal(await a("300000000000000009"), false, "shares no server with the bot");
  shared.add("300000000000000002");
  assert.equal(await a("300000000000000002"), false, "blocked beats shared-server membership");
  const down = createAuthorizer({ userIds: [], roleIds: [], fetchMember, inBotServer: async () => { throw new Error("discord unreachable"); } });
  assert.equal(await down("300000000000000001"), false);
  assert.equal(await down.recheck("300000000000000001"), null, "an outage keeps live sessions");
  assert.equal(await a.recheck("300000000000000009"), false, "left every shared server: revoked");
});

test("authorize.recheck: definite answers revoke or keep, a lookup error keeps (null)", async () => {
  const a = createAuthorizer({ userIds: ["999999999999999999"], guildId: "g", roleIds: ["r1"], fetchMember });
  assert.equal(await a.recheck("999999999999999999"), true);
  assert.equal(await a.recheck("300000000000000001"), true);
  assert.equal(await a.recheck("300000000000000002"), false); // lost the role
  assert.equal(await a.recheck("300000000000000009"), false); // left the server
  const down = createAuthorizer({ userIds: [], guildId: "g", roleIds: [], fetchMember: async () => { throw new Error("discord unreachable"); } });
  assert.equal(await down.recheck("300000000000000001"), null);
});

test("discord oauth: identify scope, code exchange, token discarded and revoked, bad answers rejected", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "tok" });
    if (url.endsWith("/users/@me")) return Response.json({ id: "300000000000000001", username: "bob", global_name: "Bob" });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const o = createDiscordOAuth({ clientId: "cid", clientSecret: "sec", redirectUri: "https://dash.example.com/auth/callback" }, fake);

  const u = new URL(o.authorizeUrl("STATE", "CHALLENGE"));
  assert.equal(u.searchParams.get("code_challenge"), "CHALLENGE");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!u.toString().includes("sec"), "the client secret is never part of the browser URL");
  assert.equal(u.origin + u.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(u.searchParams.get("scope"), "identify");
  assert.equal(u.searchParams.get("state"), "STATE");
  assert.equal(u.searchParams.get("redirect_uri"), "https://dash.example.com/auth/callback");

  assert.deepEqual(await o.completeLogin("the-code", "the-verifier"), { id: "300000000000000001", username: "Bob" });
  const tokenBody = new URLSearchParams(String(calls[0]!.init!.body));
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.equal(tokenBody.get("code"), "the-code");
  assert.equal(tokenBody.get("code_verifier"), "the-verifier");
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.some((c) => c.url.endsWith("/oauth2/token/revoke")));

  const bad = createDiscordOAuth({ clientId: "c", clientSecret: "s", redirectUri: "r" }, (async () => new Response("no", { status: 400 })) as unknown as typeof fetch);
  await assert.rejects(bad.completeLogin("x", "v"), /token exchange failed/);
  const weird = createDiscordOAuth({ clientId: "c", clientSecret: "s", redirectUri: "r" }, (async (url: string) =>
    url.endsWith("/oauth2/token") ? Response.json({ access_token: "t" }) : Response.json({ id: "../../etc" })) as unknown as typeof fetch);
  await assert.rejects(weird.completeLogin("x", "v"), /invalid user id/);
});
