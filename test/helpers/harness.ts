import { createServer as createNetServer } from "node:net";
import type { Server } from "node:http";
import { createPublicServer, type PublicDeps } from "../../src/http/server.ts";
import { createLocalServer } from "../../src/http/localServer.ts";
import { SessionStore } from "../../src/http/auth/sessions.ts";
import type { DiscordOAuth } from "../../src/http/auth/discordOAuth.ts";
import type { PlayRequest } from "../../src/sound/SoundQueue.ts";
import type { CoreDeps } from "../../src/http/coreApi.ts";

export const G = "123456789012345678";
export const C = "223456789012345678";
export const ALLOWED_USER = "323456789012345678";
export const DENIED_USER = "423456789012345678";

export const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const listen = (server: Server, port = 0) =>
  new Promise<number>((resolve) => server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

export function coreDeps(enqueued: PlayRequest[] = [], sseClients: unknown[] = []): CoreDeps {
  return {
    watcher: { payloadJson: () => "{}", addClient: (res: { write(s: string): void }) => (sseClients.push(res), res.write("data: {}\n\n")) } as never,
    library: { has: (n: string) => n === "airhorn", list: () => ["airhorn"] } as never,
    repo: { sounds: () => [{ name: "airhorn", count: 2, tags: ["x"] }] } as never,
    queue: {
      enqueue: (r: PlayRequest) => (enqueued.push(r), { ok: true, position: 1 }),
      status: () => [],
      removeQueued: () => true,
      skipCurrent: () => true,
      clearPending: () => {},
    } as never,
    canTarget: (g: string, c: string) => g === G && c === C,
  };
}

/** Fake Discord: `code` equal to a user id logs that user in. */
export const fakeOAuth: DiscordOAuth = {
  authorizeUrl: (state, challenge) => `https://discord.test/authorize?state=${state}&code_challenge=${challenge}`,
  completeLogin: async (code, verifier) => {
    if (code === "boom") throw new Error("discord down");
    if (!verifier || verifier.length < 43) throw new Error("missing PKCE verifier");
    return { id: code, username: `user-${code}` };
  },
};

export interface PublicHarness {
  base: string;
  origin: string;
  server: Server;
  sessions: SessionStore;
  now: { t: number };
  enqueued: PlayRequest[];
  sse: unknown[];
  /** Signs in through the real /auth routes and returns the Cookie header value for the session. */
  signIn(userId?: string): Promise<string>;
  close(): void;
}

export async function startPublic(over: Partial<PublicDeps> = {}): Promise<PublicHarness> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const now = { t: 1_000_000 };
  const sessions = new SessionStore({ maxAgeMs: 60_000, now: () => now.t, sweepMs: 3_600_000 });
  const enqueued: PlayRequest[] = [];
  const sse: unknown[] = [];
  const server = createPublicServer({
    ...coreDeps(enqueued, sse),
    publicBaseUrl: origin,
    sessions,
    oauth: fakeOAuth,
    authorize: async (id) => id === ALLOWED_USER,
    can: (id) => id === ALLOWED_USER, // the allowed user may do everything unless a test says otherwise
    ...over,
  });
  await listen(server, port);

  const signIn = async (userId = ALLOWED_USER) => {
    const login = await fetch(`${origin}/auth/login`, { redirect: "manual" });
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    const cb = await fetch(`${origin}/auth/callback?code=${userId}&state=${state}`, { redirect: "manual", headers: { Cookie: stateCookie } });
    const sid = cb.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("aboda_sid="));
    if (!sid || !/^aboda_sid=[^;]+$/.test(sid) || sid === "aboda_sid=") throw new Error(`sign-in failed (${cb.status})`);
    return sid;
  };

  return { base: origin, origin, server, sessions, now, enqueued, sse, signIn, close: () => { server.close(); server.closeAllConnections(); sessions.close(); } };
}

export async function startLocal(accessKey: string, enqueued: PlayRequest[] = []) {
  const server = createLocalServer({ ...coreDeps(enqueued), host: "127.0.0.1", accessKey });
  const port = await listen(server);
  return { base: `http://127.0.0.1:${port}`, server, enqueued, close: () => { server.close(); server.closeAllConnections(); } };
}

export const jsonPost = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

export const good = { sound: "airhorn", guildId: G, channelId: C };
