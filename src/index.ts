// Wiring only. Each piece below is independent; swap or fix one without touching the others.
import { Events } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNetworkConfig, loadConfig } from "./config.ts";
import { createClient, toVoiceMove } from "./discord/client.ts";
import { registerTextCommands } from "./discord/textCommands.ts";
import { createPublicServer } from "./http/server.ts";
import { createLocalServer } from "./http/localServer.ts";
import { createDiscordOAuth } from "./http/auth/discordOAuth.ts";
import { createAuthorizer } from "./http/auth/authorize.ts";
import { SessionStore } from "./http/auth/sessions.ts";
import { ImportService } from "./import/ImportService.ts";
import { createCooldown, planIntros } from "./sound/introRules.ts";
import { SoundLibrary } from "./sound/SoundLibrary.ts";
import { SoundQueue } from "./sound/SoundQueue.ts";
import { SoundRepository } from "./sound/SoundRepository.ts";
import { checkYtDlp } from "./tools/ytdlp.ts";
import { DiscordVoiceAdapter } from "./voice/DiscordVoiceAdapter.ts";
import { Watcher } from "./watcher/Watcher.ts";

const config = loadConfig();
if (!config.token) {
  console.error("DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const net = checkNetworkConfig(config);
for (const w of net.warnings) console.warn(`WARNING: ${w}`);
if (net.errors.length) {
  for (const e of net.errors) console.error(`Refusing to start: ${e}`);
  console.error("Nothing was started. Fix .env and start again.");
  process.exit(1);
}

const client = createClient();
const library = new SoundLibrary(config.soundsDir, config.acceptedExtensions);

let repo: SoundRepository;
try {
  repo = new SoundRepository(config.dbPath, { countPlays: config.countPlays });
} catch (err) {
  console.error(`Refusing to start: ${config.dbPath} is not readable as a soundbot database.\n  ${(err as Error).message}`);
  console.error("Nothing was changed. Fix or restore the file and start again.");
  process.exit(1);
}

const voice = new DiscordVoiceAdapter(client);
const watcher = new Watcher(client, {
  hideBots: config.hideBots,
  extra: () => ({ playing: queue.status() }),
});
const queue: SoundQueue = new SoundQueue({
  voice,
  resolvePath: (name) => library.resolve(name),
  maxPerGuild: config.maxQueuePerGuild,
  idleLeaveMs: config.idleLeaveMs,
  onPlayed: (name) => repo.recordPlay(name),
  onChange: () => watcher.schedule(),
  log: (msg, err) => console.error(msg, err instanceof Error ? `: ${err.message}` : (err ?? "")),
});

// Automatic intro / outro sounds
const introAllowed = createCooldown(config.introCooldownMs);
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (!config.introsEnabled) return;
  try {
    const move = toVoiceMove(oldState, newState);
    if (!move || move.userId === client.user?.id) return;
    for (const plan of planIntros(move, {
      entrance: (id) => repo.entrance(id),
      exit: (id) => repo.exit(id),
      hasSound: (name) => library.has(name),
    })) {
      if (!introAllowed(`${move.userId}:${plan.kind}`)) continue;

      const member = newState.member || oldState.member;
      const username = member?.user ? (member.user.tag ?? member.user.username) : null;

      queue.enqueue({
        sound: plan.sound,
        guildId: plan.guildId,
        channelId: plan.channelId,
        source: plan.kind,
        requestedBy: {
          userId: move.userId,
          username,
        },
      });
    }
  } catch (err) {
    console.error("Intro handling failed:", err);
  }
});

// Media import page (/import). IMPORT_ENABLED=0 removes the page and its API entirely.
const importer = config.importEnabled
  ? new ImportService({
      library,
      soundsDir: config.soundsDir,
      acceptedExtensions: config.acceptedExtensions,
      stagingDir: join(tmpdir(), "aboda-soundbot-import"),
      maxUploadBytes: config.importMaxUploadBytes,
      maxOutputSec: config.importMaxOutputSec,
      defaultTrimSec: config.importDefaultTrimSec,
      maxOutputBytes: config.importMaxOutputBytes,
      processTimeoutMs: config.importProcessTimeoutMs,
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      log: (msg, err) => console.error(msg, err instanceof Error ? `: ${err.message}` : (err ?? "")),
    })
  : undefined;

try {
  await registerTextCommands(client, { library, queue, prefix: config.commandPrefix, importer, repo });
} catch (err) {
  console.error(`Refusing to start: ${(err as Error).message}`);
  console.error("Fix the files in src/discord/commands/ and start again.");
  process.exit(1);
}

const logError = (msg: string, err?: unknown) => console.error(msg, err instanceof Error ? `: ${err.message}` : (err ?? ""));

// What both listeners serve. The listeners differ only in how they authenticate.
const core = {
  watcher,
  library,
  repo,
  queue,
  canTarget: (guildId: string, channelId: string) =>
    !!client.guilds.cache.get(guildId)?.channels.cache.get(channelId)?.isVoiceBased(),
};

// ---- PUBLIC listener: Discord OAuth2 + server-side sessions (the Cloudflare Tunnel origin) ----
const sessions = new SessionStore({ maxAgeMs: config.sessionMaxMs });
const authorizer = createAuthorizer({
  userIds: config.dashboardUserIds,
  guildId: config.dashboardGuildId || undefined,
  roleIds: config.dashboardRoleIds,
  log: logError,
  fetchMember: async (guildId, userId) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error("dashboard server is not loaded (bot offline or not in that server)");
    try {
      const member = await guild.members.fetch(userId);
      return { roles: [...member.roles.cache.keys()] };
    } catch (err) {
      // Discord error 10007 = Unknown Member, 10013 = Unknown User: a definite "not in the server".
      const code = (err as { code?: number }).code;
      if (code === 10007 || code === 10013) return null;
      throw err; // anything else is "unknown", not "no"
    }
  },
});
const oauthReady = !!(config.publicBaseUrl && config.discordClientId && config.discordClientSecret);
const publicBase = config.publicBaseUrl || `http://localhost:${config.publicPort}`;
const publicServer = createPublicServer({
  ...core,
  publicBaseUrl: publicBase,
  sessions,
  oauth: oauthReady
    ? createDiscordOAuth({
        clientId: config.discordClientId,
        clientSecret: config.discordClientSecret,
        redirectUri: `${publicBase}/auth/callback`,
      })
    : undefined,
  authorize: authorizer,
  recheck: authorizer.recheck,
  recheckMs: config.sessionRecheckMs,
  importer,
  // Log viewer page (/logs). Point these at the files your bot writes its logs to.
  logs: {
    soundPlayFile: join(process.cwd(), "sound-play-logs.json"),
    voiceActivityFile: join(process.cwd(), "voice-activity-logs.json"),
  },
});

// ---- LOCAL listener: access key in a header, playback/voice API only ----
const localServer = config.localEnabled
  ? createLocalServer({ ...core, host: config.localHost, accessKey: config.localAccessKey })
  : undefined;

publicServer.listen(config.publicPort, config.publicHost, () => {
  console.log(`Public dashboard: listening on ${config.publicHost}:${config.publicPort}; it answers only for ${new URL(publicBase).host} (sign in at ${publicBase}/)`);
  console.log(`Sounds: ${library.list().length} found in ${config.soundsDir}`);
  // Informational only: URL imports are not built yet, so a missing yt-dlp never stops the bot.
  void checkYtDlp({ path: config.ytdlpPath }).then((y) =>
    y.available ? console.log(`yt-dlp ${y.version} (${y.path})${y.problem ? `\n  Note: ${y.problem}` : ""}`) : console.log(`yt-dlp not available: ${y.problem}`),
  );
});

if (localServer) {
  localServer.listen(config.localPort, config.localHost, () =>
    console.log(`Local integration API: listening on ${config.localHost}:${config.localPort} (X-Access-Key header required)`),
  );
} else {
  console.log("Local integration API: off (set LOCAL_ACCESS_KEY to enable it).");
}

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);
  console.log(`Invite: https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot&permissions=${1024 + 1048576 + 2097152}`);
});
client.on(Events.Error, (err) => console.error("Discord client error:", err.message));

// Clean shutdown: leave voice, save counters, close everything.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  queue.shutdown();
  repo.flush();
  watcher.close();
  publicServer.close();
  localServer?.close();
  sessions.close();
  importer?.close();
  await client.destroy();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

client.login(config.token).catch((err: Error) => {
  console.error("Discord login failed:", err.message);
  process.exit(1);
});