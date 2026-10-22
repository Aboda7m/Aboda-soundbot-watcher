// Wiring only. Each piece below is independent; swap or fix one without touching the others.
import { Events } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createClient, toVoiceMove } from "./discord/client.ts";
import { registerTextCommands } from "./discord/textCommands.ts";
import { createHttpServer } from "./http/server.ts";
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
      queue.enqueue({ sound: plan.sound, guildId: plan.guildId, channelId: plan.channelId, source: plan.kind });
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

registerTextCommands(client, { library, queue, prefix: config.commandPrefix, importer });

const server = createHttpServer({
  host: config.host,
  port: config.port,
  accessKey: config.accessKey,
  watcher,
  library,
  repo,
  queue,
  importer,
  canTarget: (guildId, channelId) =>
    !!client.guilds.cache.get(guildId)?.channels.cache.get(channelId)?.isVoiceBased(),
});

server.listen(config.port, config.host, () => {
  console.log(`Voice page: http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}/${config.accessKey ? "?key=…" : ""}`);
  console.log(`Sounds: ${library.list().length} found in ${config.soundsDir}`);
  // Informational only: URL imports are not built yet, so a missing yt-dlp never stops the bot.
  void checkYtDlp({ path: config.ytdlpPath }).then((y) =>
    y.available ? console.log(`yt-dlp ${y.version} (${y.path})${y.problem ? `\n  Note: ${y.problem}` : ""}`) : console.log(`yt-dlp not available: ${y.problem}`),
  );
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  if (!loopback && !config.accessKey)
    console.warn("WARNING: listening beyond localhost with no ACCESS_KEY. Reading is open and playback is disabled.");
});

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
  server.close();
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