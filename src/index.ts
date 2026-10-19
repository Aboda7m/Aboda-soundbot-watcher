import { Client, Events, GatewayIntentBits } from "discord.js";
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 3939);
const HOST = process.env.HOST ?? "127.0.0.1";
const ACCESS_KEY = process.env.ACCESS_KEY ?? "";
const HIDE_BOTS = process.env.HIDE_BOTS === "1";
const LOOPBACK_ONLY = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

// ---------- Snapshot ----------

interface MemberInfo {
  id: string;
  name: string;
  avatar: string | null;
  bot: boolean;
  muted: boolean;
  deafened: boolean;
  streaming: boolean;
  camera: boolean;
}
interface ChannelInfo {
  id: string;
  name: string;
  members: MemberInfo[];
}
interface GuildInfo {
  id: string;
  name: string;
  channels: ChannelInfo[];
}
interface Snapshot {
  ready: boolean;
  total: number;
  guilds: GuildInfo[];
}

// Only Guilds + GuildVoiceStates: no privileged intents needed.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

function buildSnapshot(): Snapshot {
  const guilds: GuildInfo[] = [];
  let total = 0;

  for (const guild of client.guilds.cache.values()) {
    if (!guild.available) continue;

    const channels = new Map<string, { pos: number; info: ChannelInfo }>();

    for (const vs of guild.voiceStates.cache.values()) {
      const channel = vs.channel;
      if (!channel) continue; // not in a voice channel, or channel not visible to the bot
      const member = vs.member;
      if (HIDE_BOTS && member?.user.bot) continue;

      let entry = channels.get(channel.id);
      if (!entry) {
        entry = {
          pos: channel.rawPosition,
          info: { id: channel.id, name: channel.name, members: [] },
        };
        channels.set(channel.id, entry);
      }

      entry.info.members.push({
        id: vs.id,
        name: member?.displayName ?? member?.user.username ?? "Unknown user",
        avatar: member?.displayAvatarURL({ size: 64, extension: "png" }) ?? null,
        bot: member?.user.bot ?? false,
        muted: !!(vs.selfMute || vs.serverMute),
        deafened: !!(vs.selfDeaf || vs.serverDeaf),
        streaming: !!vs.streaming,
        camera: !!vs.selfVideo,
      });
      total++;
    }

    if (channels.size === 0) continue; // nobody connected: leave the server off the page

    const sorted = [...channels.values()]
      .sort((a, b) => a.pos - b.pos)
      .map(({ info }) => {
        info.members.sort((a, b) => a.name.localeCompare(b.name));
        return info;
      });

    guilds.push({ id: guild.id, name: guild.name, channels: sorted });
  }

  guilds.sort((a, b) => a.name.localeCompare(b.name));
  return { ready: client.isReady(), total, guilds };
}

// ---------- Push to browsers (Server-Sent Events) ----------

const sseClients = new Set<ServerResponse>();
let lastJson = "";
let timer: NodeJS.Timeout | null = null;

function publish() {
  const json = JSON.stringify(buildSnapshot());
  if (json === lastJson) return; // nothing visible changed
  lastJson = json;
  for (const res of sseClients) res.write(`data: ${json}\n\n`);
}

// Coalesce bursts (e.g. many people moving at once, or a reconnect replaying state).
function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    publish();
  }, 250);
}

const REFRESH_EVENTS = [
  Events.ClientReady,
  Events.VoiceStateUpdate,
  Events.GuildCreate,
  Events.GuildDelete,
  Events.GuildUnavailable,
  Events.GuildUpdate,
  Events.ChannelUpdate,
  Events.ChannelDelete,
  Events.ShardDisconnect,
  Events.ShardReconnecting,
  Events.ShardResume,
] as const;
for (const ev of REFRESH_EVENTS) client.on(ev as string, schedule);

setInterval(() => {
  for (const res of sseClients) res.write(": ping\n\n"); // keeps proxies/idle timeouts from closing the stream
}, 25_000).unref();

// ---------- HTTP ----------

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const STATIC: Record<string, { body: Buffer; type: string }> = {
  "/": { body: readFileSync(join(pub, "index.html")), type: "text/html; charset=utf-8" },
  "/app.js": { body: readFileSync(join(pub, "app.js")), type: "text/javascript; charset=utf-8" },
  "/style.css": { body: readFileSync(join(pub, "style.css")), type: "text/css; charset=utf-8" },
};

const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src https://cdn.discordapp.com; connect-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function keyOk(provided: string | null): boolean {
  if (!ACCESS_KEY) return true;
  const a = Buffer.from(provided ?? "");
  const b = Buffer.from(ACCESS_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");

  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" }).end();
    return;
  }
  // Blocks DNS-rebinding: a hostile website can't reach this server through its own hostname.
  if (LOOPBACK_ONLY) {
    const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostName)) {
      res.writeHead(403).end();
      return;
    }
  }
  if (!keyOk(url.searchParams.get("key"))) {
    res.writeHead(401, HEADERS).end("Missing or wrong key.");
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      ...HEADERS,
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\ndata: ${JSON.stringify(buildSnapshot())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (url.pathname === "/api/voice") {
    res.writeHead(200, { ...HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(buildSnapshot()));
    return;
  }

  const file = STATIC[url.pathname];
  if (file) {
    res.writeHead(200, { ...HEADERS, "Content-Type": file.type }).end(file.body);
    return;
  }
  res.writeHead(404, HEADERS).end("Not found");
});

server.on("error", (err) => {
  console.error(`Web server failed on ${HOST}:${PORT}:`, err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Voice page: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/${ACCESS_KEY ? "?key=…" : ""}`);
  if (!LOOPBACK_ONLY && !ACCESS_KEY) {
    console.warn("WARNING: listening beyond localhost with no ACCESS_KEY. Anyone who can reach this port can see who is in voice.");
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);
  console.log(
    `Invite: https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot&permissions=1024`
  );
});

client.login(TOKEN).catch((err) => {
  console.error("Discord login failed:", err.message);
  process.exit(1);
});
