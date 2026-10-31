// Wiring only. Each piece below is independent; swap or fix one without touching the others.
import { Events } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNetworkConfig, loadConfig } from "./config.ts";
import { createClient, toVoiceMove } from "./discord/client.ts";
import { VoiceHub } from "./voice/VoiceHub.ts";
import { loadVoicePoolConfig } from "./voice/voicePoolConfig.ts";
import { registerTextCommands } from "./discord/textCommands.ts";
import { createPublicServer } from "./http/server.ts";
import { recordingManager } from "./recording/RecordingManager.ts";
import { createLocalServer } from "./http/localServer.ts";
import { createDiscordOAuth } from "./http/auth/discordOAuth.ts";
import { createAuthorizer } from "./http/auth/authorize.ts";
import { SessionStore } from "./http/auth/sessions.ts";
import { ImportService } from "./import/ImportService.ts";
import { createCooldown, planIntros, shouldPlayEntrance } from "./sound/introRules.ts";
import { resolveAutomaticEntrance } from "./sound/entranceResolver.ts";
import { SoundLibrary } from "./sound/SoundLibrary.ts";
import { SoundQueue } from "./sound/SoundQueue.ts";
import { SoundRepository } from "./sound/SoundRepository.ts";
import { AccessPolicy, type Capability } from "./access/AccessPolicy.ts";
import { checkYtDlp } from "./tools/ytdlp.ts";
import { DiscordVoiceAdapter } from "./voice/DiscordVoiceAdapter.ts";
import { Watcher } from "./watcher/Watcher.ts";
import { StreamManager } from "./streaming/StreamManager.ts";
import { Mp4StreamProvider } from "./streaming/Mp4StreamProvider.ts";
import { loadVideoStreamConfig } from "./streaming/videoStreamConfig.ts";

const config = loadConfig();
const videoStreamConfig = await loadVideoStreamConfig();
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
const workerClients = config.voiceWorkerTokens.map(() => createClient(true));
const voicePoolConfig = loadVoicePoolConfig();
const voiceHub = new VoiceHub({ waitMs: voicePoolConfig.scheduler.waitMs, recordingPreferredWorker: voicePoolConfig.scheduler.recordingPreferredWorker });
const mainVoice = new DiscordVoiceAdapter(client, { group: "main", isPinned: () => false });
voiceHub.addSlot({ id: "main", label: "Main bot", worker: false, adapter: mainVoice, identity: () => client.user ? { id: client.user.id, tag: client.user.tag } : null });
workerClients.forEach((worker, index) => {
  const id = `worker-${index + 1}`;
  const adapter = new DiscordVoiceAdapter(worker, { group: id, isPinned: () => false });
  voiceHub.addSlot({ id, label: `Worker ${index + 1}`, worker: true, adapter, identity: () => worker.user ? { id: worker.user.id, tag: worker.user.tag } : null });
  worker.on(Events.Error, (err) => console.error(`[${id}] Discord client error:`, err.message));
});
const library = new SoundLibrary(config.soundsDir, config.acceptedExtensions);
const streamManager = new StreamManager({
  directory: videoStreamConfig.streamsDirectory,
  provider: new Mp4StreamProvider({ directory: videoStreamConfig.streamsDirectory, ffprobePath: config.ffprobePath }),
});

let repo: SoundRepository;
try {
  repo = new SoundRepository(config.dbPath, { countPlays: config.countPlays });
} catch (err) {
  console.error(`Refusing to start: ${config.dbPath} is not readable as a soundbot database.\n  ${(err as Error).message}`);
  console.error("Nothing was changed. Fix or restore the file and start again.");
  process.exit(1);
}

const voice = voiceHub;
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
  onStarted: (item) => {
    if (item.source !== "entrance") return;
    const t = now();
    if (item.requestedBy?.userId) lastEntranceByUser.set(`${item.guildId}:${item.requestedBy.userId}`, t);
    lastEntranceByGuild.set(item.guildId, t);
  },
  onFinished: (item) => { if (item.source === "entrance" && item.requestedBy?.userId) pendingEntranceUsers.delete(`${item.guildId}:${item.requestedBy.userId}`); },
  onChange: () => watcher.schedule(),
  log: (msg, err) => console.error(msg, err instanceof Error ? `: ${err.message}` : (err ?? "")),
});

// Who may use the bot (whitelist/blacklist) and who holds which permission. Owners come from OWNER_USER_IDS in .env;
// the rest is stored in access.json (created with open defaults when missing) and changed with the owner-only
// `!access` command (or by editing the file). Legacy DASHBOARD_ALLOWED_USER_IDS are dashboard-only users, not owners.
let access: AccessPolicy;
try {
  access = new AccessPolicy(config.accessFile, {
    owners: config.ownerUserIds,
    dashboardUsers: config.dashboardUserIds.filter((id) => !config.ownerUserIds.includes(id)),
    log: (msg, err) => console.error(msg, err instanceof Error ? `: ${err.message}` : (err ?? "")),
  });
} catch (err) {
  console.error(`Refusing to start: ${(err as Error).message}`);
  console.error("Fix or delete that file and start again.");
  process.exit(1);
}

{
  const s = access.snapshot();
  console.log(
    `Access: bot ${s.whitelistEnabled ? "restricted to the whitelist" : "open to everyone"}, blacklist ${s.blacklistEnabled ? "on" : "off"}, ` +
      `${s.owners.length} owner(s), ${Object.keys(s.grants).length} user(s) with permissions (${config.accessFile})`,
  );
}

// Automatic intro / outro sounds
const introAllowed = createCooldown(config.introCooldownMs); // legacy exit cooldown semantics
const lastEntranceByUser = new Map<string, number>();
const lastEntranceByGuild = new Map<string, number>();
const disconnectedAt = new Map<string, number>();
const pendingEntranceUsers = new Set<string>();
const envSeconds = (key: string, fallback: number) => {
  const value = Number(process.env[key] ?? fallback);
  return Number.isInteger(value) && value >= 0 && value <= 86400 ? value : fallback;
};
const GLOBAL_ENTRANCE_COOLDOWN_SEC = envSeconds("ENTRANCE_COOLDOWN_SEC", 0);
const GLOBAL_RECONNECT_GRACE_SEC = envSeconds("ENTRANCE_RECONNECT_GRACE_SEC", 300);
const now = () => Date.now();
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (!config.introsEnabled) return;
  try {
    const move = toVoiceMove(oldState, newState);
    if (!move || move.userId === client.user?.id) return;
    // Same whitelist/blacklist as the text commands: no automatic sounds for servers or users the owner has not allowed.
    if (!access.canUseBot(move.guildId, move.userId)) return;
    // Only a real channel -> no-channel transition starts a reconnect interval.
    const sessionKey = `${move.guildId}:${move.userId}`;
    if (move.fromChannelId && !move.toChannelId) {
      if (!disconnectedAt.has(sessionKey)) disconnectedAt.set(sessionKey, now());
    }
    const reconnectAt = !move.fromChannelId && move.toChannelId ? disconnectedAt.get(sessionKey) : undefined;
    const disconnectedForMs = reconnectAt === undefined ? null : Math.max(0, now() - reconnectAt);
    if (!move.toChannelId) {
      for (const plan of planIntros(move, { entrance: () => undefined, exit: (id) => repo.exit(id), hasSound: (name) => library.has(name) })) {
        if (!introAllowed(`${move.userId}:${plan.kind}`)) continue;
        queue.enqueue({ sound: plan.sound, guildId: plan.guildId, channelId: plan.channelId, source: plan.kind,
          requestedBy: { userId: move.userId, username: newState.member?.user?.tag ?? oldState.member?.user?.tag ?? null } });
      }
      return;
    }
    if (move.toChannelId && reconnectAt !== undefined) disconnectedAt.delete(sessionKey);
    if (move.fromChannelId) {
      const exitSound = repo.exit(move.userId);
      if (exitSound && library.has(exitSound) && introAllowed(`${move.userId}:exit`)) queue.enqueue({ sound: exitSound, guildId: move.guildId, channelId: move.fromChannelId, source: "exit", requestedBy: { userId: move.userId, username: newState.member?.user?.tag ?? oldState.member?.user?.tag ?? null } });
    }
    // Moving between voice channels is not a fresh entrance. Keep the exit sound above,
    // but only run entrance policy for a join from outside voice (including reconnects).
    if (!shouldPlayEntrance(move)) return;
    const policy = repo.guildEntranceSettings(move.guildId);
    const resolution = resolveAutomaticEntrance({
      guildEnabled: policy.enabled,
      adminAssignment: repo.guildEntranceAssignment(move.userId, move.guildId),
      userGuildPreference: repo.userGuildEntrance(move.userId, move.guildId),
      globalPreference: repo.entrance(move.userId),
      personalDurationSec: repo.userEntranceDuration(move.userId, move.guildId),
      guildDurationSec: policy.maxDurationSec,
      botAdminDurationSec: repo.botEntranceDurationCap(move.userId),
    });
    const selectedSound = resolution.sound;
    if (!resolution.allowed || !selectedSound || !library.has(selectedSound)) return;

    const personalTiming = policy.allowUserTiming === false ? {} : repo.userEntranceTiming(move.userId, move.guildId);
    const configuredGrace = policy.reconnectGraceSec === undefined ? GLOBAL_RECONNECT_GRACE_SEC : policy.reconnectGraceSec;
    const minGrace = policy.minReconnectGraceSec ?? 0;
    const userGrace = personalTiming.reconnectGraceSec;
    const effectiveGrace = userGrace === undefined
      ? configuredGrace === null ? (minGrace > 0 ? minGrace : null) : Math.max(configuredGrace, minGrace)
      : userGrace === null ? (minGrace > 0 ? minGrace : null) : Math.max(userGrace, minGrace);
    if (disconnectedForMs !== null && effectiveGrace !== null && disconnectedForMs < effectiveGrace * 1000) {
      console.info(`[entrance] suppressed reconnect: guild=${move.guildId} user=${move.userId} disconnectedSec=${Math.floor(disconnectedForMs / 1000)} graceSec=${effectiveGrace}`);
      return;
    }
    const userCooldownDefault = policy.userCooldownSec ?? GLOBAL_ENTRANCE_COOLDOWN_SEC;
    const enforcedCooldown = policy.enforcedUserCooldownSec ?? 0;
    const requestedCooldown = policy.allowUserCooldown === false ? undefined : personalTiming.cooldownSec;
    const effectiveUserCooldown = Math.max(enforcedCooldown, requestedCooldown === undefined ? userCooldownDefault : requestedCooldown ?? 0);
    const key = `${move.guildId}:${move.userId}`;
    const t = now();
    if (pendingEntranceUsers.has(key)) return;
    const lastUser = lastEntranceByUser.get(`${move.guildId}:${move.userId}`);
    if (lastUser !== undefined && t - lastUser < effectiveUserCooldown * 1000) return;
    const guildCooldown = policy.guildCooldownSec ?? 0;
    const lastGuild = lastEntranceByGuild.get(move.guildId);
    if (guildCooldown > 0 && lastGuild !== undefined && t - lastGuild < guildCooldown * 1000) return;

    pendingEntranceUsers.add(key);
    const result = queue.enqueue({ sound: selectedSound, guildId: move.guildId, channelId: move.toChannelId, source: "entrance",
      maxDurationSec: resolution.maxDurationSec,
      requestedBy: { userId: move.userId, username: newState.member?.user?.tag ?? newState.member?.user?.username ?? null } });
    if (!result.ok) pendingEntranceUsers.delete(key);
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
  await registerTextCommands(client, { library, queue, prefix: config.commandPrefix, importer, repo, access, voiceHub, streamManager });
} catch (err) {
  console.error(`Refusing to start: ${(err as Error).message}`);
  console.error("Fix the files in src/discord/commands/ and start again.");
  process.exit(1);
}

const logError = (msg: string, err?: unknown) => console.error(msg, err instanceof Error ? `: ${err.message}` : (err ?? ""));

// What both listeners serve. The listeners differ only in how they authenticate.
const guildAccessCache = new Map<string, { expiresAt: number; guildIds: string[] }>();
const GUILD_ACCESS_CACHE_MS = 30_000;
// Invalidate a cached membership decision immediately when Discord delivers a membership event.
client.on(Events.GuildMemberAdd, (member) => guildAccessCache.delete(member.id));
client.on(Events.GuildMemberRemove, (member) => guildAccessCache.delete(member.id));

/**
 * Resolve the guilds this dashboard user can actually access. Membership is checked against the bot's
 * current guilds, while the existing whitelist/blacklist policy remains an additional restriction.
 * A short cache avoids REST lookups on every SSE event; failed lookups never grant access.
 */
async function accessibleGuildIds(userId: string): Promise<readonly string[]> {
  if (access.isBlocked(userId)) return [];
  const cached = guildAccessCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.guildIds.filter((id) => client.guilds.cache.has(id) && access.guildAllowed(id, userId));

  const guilds = [...client.guilds.cache.values()].filter((g) => g.available && access.guildAllowed(g.id, userId));
  const ids = await Promise.all(guilds.map(async (guild) => {
    if (guild.members.cache.has(userId)) return guild.id;
    try {
      await guild.members.fetch(userId);
      return guild.id;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== 10007 && code !== 10013) {
        console.warn(`Could not verify dashboard membership for ${userId} in guild ${guild.id}: ${(err as Error).message}`);
      }
      return null;
    }
  }));
  const result = ids.filter((id): id is string => id !== null);
  guildAccessCache.set(userId, { expiresAt: Date.now() + GUILD_ACCESS_CACHE_MS, guildIds: result });
  return result;
}

const core = {
  watcher,
  library,
  repo,
  queue,
  accessibleGuildIds,
  // userId (optional) lets owners through whitelist/blacklist; it is only passed once the dashboard API supplies the signed-in user.
  canTarget: (guildId: string, channelId: string, userId?: string) =>
    access.guildAllowed(guildId, userId) && !!client.guilds.cache.get(guildId)?.channels.cache.get(channelId)?.isVoiceBased(),
};

// ---- PUBLIC listener: Discord OAuth2 + server-side sessions (the Cloudflare Tunnel origin) ----
const sessions = new SessionStore({ maxAgeMs: config.sessionMaxMs, file: config.sessionFile, log: logError });
const authorizer = createAuthorizer({
  userIds: [...config.ownerUserIds, ...config.dashboardUserIds], // owners, plus legacy dashboard-only ids (they are not owners)
  extraAllow: (id) => access.can(id, "dashboard"), // users the owner granted `dashboard` to
  deny: (id) => access.isBlocked(id),              // blacklisted users, even if a server rule would let them in
  // Anyone who shares a (not blocked / not un-whitelisted) server with the bot may sign in. Looked up live, nothing to maintain.
  inBotServer: async (userId) => {
    const guilds = [...client.guilds.cache.values()].filter((g) => access.guildAllowed(g.id));
    if (client.guilds.cache.size === 0) throw new Error("bot is not connected to any server yet");
    if (guilds.some((g) => g.members.cache.has(userId))) return true;
    let failed: unknown;
    const found = await Promise.all(
      guilds.map(async (g) => {
        try {
          await g.members.fetch(userId); // single-member REST lookup: needs no privileged intent
          return true;
        } catch (err) {
          const code = (err as { code?: number }).code;
          if (code === 10007 || code === 10013) return false; // not a member of this server
          failed = err;
          return false;
        }
      }),
    );
    if (found.some(Boolean)) return true;
    if (failed) throw failed; // could not check every server: unknown, not "no"
    return false;
  },

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
  discordClient: client,
  accessPolicy: access,
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
  // The server-side check made on every request. A user admitted because they share a server with the bot (or via the
  // DASHBOARD_GUILD_ID rule) has no `dashboard` grant, but holds a live session that the periodic recheck keeps honest;
  // a blocked user never passes.
  can: (userId: string, capability: Capability) =>
    access.can(userId, capability) ||
    (capability === "dashboard" && !access.isBlocked(userId) && sessions.all().some((s) => s.user.id === userId)),
  recheck: authorizer.recheck,
  recheckMs: config.sessionRecheckMs,
  importer,
  // Log viewer page (/logs). Point these at the files your bot writes its logs to.
  logs: {
    soundPlayFile: join(process.cwd(), "sound-play-logs.json"),
    voiceActivityFile: join(process.cwd(), "voice-activity-logs.json"),
  },
  // Recordings browser (/recordings). Needs the owner to grant the "recordings" permission.
  recordings: {
    dir: recordingManager.baseDir,
    ffmpegPath: config.ffmpegPath,
    voiceActivityFile: join(process.cwd(), "voice-activity-logs.json"),
    names: {
      guild: (id) => client.guilds.cache.get(id)?.name,
      channel: (gid, cid) => client.guilds.cache.get(gid)?.channels.cache.get(cid)?.name,
      user: (id) => client.users.cache.get(id)?.username,
    },
  },
});

// ---- LOCAL listener: access key in a header, playback/voice API only ----
const localSessions = new SessionStore({ maxAgeMs: config.localSessionMaxMs }); // memory only, never as long-lived as the Discord one
const localServer = config.localEnabled
  ? createLocalServer({
      ...core,
      host: config.localHost,
      accessKey: config.localAccessKey,
      dashboard: config.localDashboard ? { sessions: localSessions } : undefined,
    })
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
    console.log(`Local integration API: listening on ${config.localHost}:${config.localPort} (X-Access-Key header for tools${config.localDashboard ? "; browsers sign in with the key at /" : ""})`),
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
  localSessions.close();
  importer?.close();
  await Promise.allSettled([...workerClients.map((worker) => worker.destroy()), client.destroy()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

client.login(config.token).then(async () => {
  await Promise.all(workerClients.map(async (worker, index) => {
    try {
      await worker.login(config.voiceWorkerTokens[index]!);
      console.log(`[voice worker ${index + 1}] logged in as ${worker.user?.tag ?? "unknown"}`);
    } catch (err) {
      console.error(`[voice worker ${index + 1}] login failed; continuing without this worker:`, (err as Error).message);
      await worker.destroy().catch(() => {});
    }
  }));
}).catch((err: Error) => {
  console.error("Discord login failed:", err.message);
  process.exit(1);
});