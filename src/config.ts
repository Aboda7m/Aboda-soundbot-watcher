import { resolve } from "node:path";
import { defaultYtDlpPath } from "./tools/ytdlp.ts";
import { isLoopbackHost } from "./http/common.ts";

export interface Config {
  token: string;
  /** PUBLIC dashboard listener (the Cloudflare Tunnel origin). Authenticates with Discord OAuth2 only. */
  publicPort: number;
  publicHost: string;
  /** A non-loopback legacy HOST that was ignored (the public listener only goes wider when PUBLIC_HOST says so). */
  ignoredLegacyHost: string;
  /** Public origin the browser sees, e.g. https://dash.example.com. Used for the OAuth redirect and cookie flags. */
  publicBaseUrl: string;
  discordClientId: string;
  discordClientSecret: string;
  /** Who may sign in to the public dashboard. Nobody is allowed unless at least one rule is configured. */
  dashboardUserIds: string[];
  dashboardGuildId: string;
  dashboardRoleIds: string[];
  sessionMaxMs: number;
  /** How often live sessions are re-authorized (0 = never). Only matters for guild/role rules. */
  sessionRecheckMs: number;
  /** LOCAL integration listener. Authenticates with an access key in a header only. */
  localEnabled: boolean;
  localPort: number;
  localHost: string;
  localAccessKey: string;
  /** true when the key came from the legacy ACCESS_KEY variable */
  localKeyIsLegacy: boolean;
  hideBots: boolean;
  soundsDir: string;
  dbPath: string;
  acceptedExtensions: string[];
  introsEnabled: boolean;
  introCooldownMs: number;
  maxQueuePerGuild: number;
  idleLeaveMs: number;
  countPlays: boolean;
  commandPrefix: string;
  importEnabled: boolean;
  importMaxUploadBytes: number;
  importMaxOutputSec: number;
  importDefaultTrimSec: number;
  importMaxOutputBytes: number;
  importProcessTimeoutMs: number;
  ffmpegPath: string;
  ffprobePath: string;
  /** portable yt-dlp: tools/yt-dlp/bin by default, YTDLP_PATH to override */
  ytdlpPath: string;
}

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const flag = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v.trim() === "" ? fallback : v.trim() === "1" || v.trim().toLowerCase() === "true";

const list = (v: string | undefined): string[] =>
  (v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/**
 * Public bind address. PUBLIC_HOST wins. The old generic HOST is still honored, but only for loopback values:
 * an old `HOST=0.0.0.0` (written when this one listener also served the LAN) must not silently widen the
 * tunnel origin. LAN access now belongs to the local listener (LOCAL_HOST).
 */
function resolvePublicHost(env: NodeJS.ProcessEnv): { host: string; ignored: string } {
  const explicit = env.PUBLIC_HOST?.trim();
  if (explicit) return { host: explicit, ignored: "" };
  const legacy = env.HOST?.trim() ?? "";
  if (legacy && !isLoopbackHost(legacy)) return { host: "127.0.0.1", ignored: legacy };
  return { host: legacy || "127.0.0.1", ignored: "" };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pub = resolvePublicHost(env);
  // Existing setups keep working: the old ACCESS_KEY becomes the LOCAL key. It is never used by the public listener.
  const localKey = env.LOCAL_ACCESS_KEY?.trim() || env.ACCESS_KEY?.trim() || "";
  return {
    token: env.DISCORD_TOKEN ?? "",
    publicPort: num(env.PORT, 3939),
    publicHost: pub.host,
    ignoredLegacyHost: pub.ignored,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    discordClientId: (env.DISCORD_CLIENT_ID ?? "").trim(),
    discordClientSecret: (env.DISCORD_CLIENT_SECRET ?? "").trim(),
    dashboardUserIds: list(env.DASHBOARD_ALLOWED_USER_IDS),
    dashboardGuildId: (env.DASHBOARD_GUILD_ID ?? "").trim(),
    dashboardRoleIds: list(env.DASHBOARD_ROLE_IDS),
    sessionMaxMs: Math.max(1, num(env.SESSION_MAX_HOURS, 12)) * 3_600_000,
    sessionRecheckMs: num(env.SESSION_RECHECK_MINUTES, 10) * 60_000,
    localEnabled: flag(env.LOCAL_ENABLED, true) && localKey !== "",
    localPort: num(env.LOCAL_PORT, 3940),
    localHost: env.LOCAL_HOST?.trim() || "127.0.0.1",
    localAccessKey: localKey,
    localKeyIsLegacy: !env.LOCAL_ACCESS_KEY?.trim() && !!env.ACCESS_KEY?.trim(),
    hideBots: flag(env.HIDE_BOTS, false),
    soundsDir: resolve(env.SOUNDS_DIR ?? "./sounds"),
    dbPath: resolve(env.DB_PATH ?? "./db.json"),
    acceptedExtensions: (env.ACCEPTED_EXTENSIONS ?? ".mp3,.wav")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    introsEnabled: flag(env.INTROS_ENABLED, true),
    introCooldownMs: num(env.INTRO_COOLDOWN_MS, 3000),
    maxQueuePerGuild: Math.max(1, num(env.MAX_QUEUE_PER_GUILD, 10)),
    idleLeaveMs: num(env.IDLE_LEAVE_MS, 5000),
    countPlays: flag(env.COUNT_PLAYS, true),
    commandPrefix: env.COMMAND_PREFIX?.trim() || "!",
    importEnabled: flag(env.IMPORT_ENABLED, true),
    importMaxUploadBytes: Math.max(1, num(env.IMPORT_MAX_UPLOAD_MB, 100)) * 1024 * 1024,
    importMaxOutputSec: Math.max(1, num(env.IMPORT_MAX_OUTPUT_SEC, 600)),
    importDefaultTrimSec: Math.max(1, num(env.IMPORT_DEFAULT_TRIM_SEC, 10)),
    importMaxOutputBytes: Math.max(1, num(env.IMPORT_MAX_OUTPUT_MB, 64)) * 1024 * 1024,
    importProcessTimeoutMs: Math.max(1, num(env.IMPORT_PROCESS_TIMEOUT_SEC, 120)) * 1000,
    ffmpegPath: env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: env.FFPROBE_PATH?.trim() || "ffprobe",
    ytdlpPath: env.YTDLP_PATH?.trim() ? resolve(env.YTDLP_PATH.trim()) : defaultYtDlpPath(),
  };
}


const WILDCARD = new Set(["", "0.0.0.0", "::", "[::]"]);

export interface NetworkCheck {
  /** Problems that make the configuration unsafe or unusable: the bot refuses to start. */
  errors: string[];
  warnings: string[];
}

/** Pure checks on the two-listener setup, so they can be tested and printed at startup. */
export function checkNetworkConfig(c: Config): NetworkCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  let base: URL | null = null;
  if (c.publicBaseUrl) {
    try {
      base = new URL(c.publicBaseUrl);
      if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("scheme");
      if (base.pathname !== "/" || base.search || base.hash) throw new Error("path");
    } catch {
      errors.push(`PUBLIC_BASE_URL must be an origin such as https://dash.example.com (got "${c.publicBaseUrl}").`);
      base = null;
    }
  }
  if (base && base.protocol === "http:" && !isLoopbackHost(base.hostname)) {
    warnings.push("PUBLIC_BASE_URL is plain http on a non-local host: session cookies will travel unencrypted. Use the https tunnel hostname.");
  }

  const missing = [
    !c.publicBaseUrl && "PUBLIC_BASE_URL",
    !c.discordClientId && "DISCORD_CLIENT_ID",
    !c.discordClientSecret && "DISCORD_CLIENT_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    warnings.push(`Public dashboard sign-in is not configured (missing ${missing.join(", ")}). Every dashboard route will refuse access until it is.`);
  }
  if (!c.publicBaseUrl) {
    warnings.push(`PUBLIC_BASE_URL is not set, so the public listener only answers requests whose Host header is localhost:${c.publicPort}; the tunnel hostname, 127.0.0.1 and LAN addresses get HTTP 421.`);
  }
  if (c.ignoredLegacyHost) {
    warnings.push(`HOST=${c.ignoredLegacyHost} was ignored: the public listener stays on 127.0.0.1 (the tunnel origin). Remove HOST from .env, or set PUBLIC_HOST to choose a different address deliberately. For LAN devices use LOCAL_HOST (local listener).`);
  }
  if (c.dashboardUserIds.length === 0 && !c.dashboardGuildId) {
    warnings.push("No DASHBOARD_ALLOWED_USER_IDS or DASHBOARD_GUILD_ID set: nobody is authorized to sign in to the public dashboard.");
  }
  if (c.dashboardRoleIds.length > 0 && !c.dashboardGuildId) {
    warnings.push("DASHBOARD_ROLE_IDS is ignored without DASHBOARD_GUILD_ID.");
  }
  if (!isLoopbackHost(c.publicHost)) {
    warnings.push(`The public listener is bound to ${c.publicHost || "all interfaces"}. cloudflared on the same PC only needs 127.0.0.1; a wider bind also exposes plain-http port ${c.publicPort} to your network.`);
  }

  if (c.localEnabled) {
    if (c.localPort === c.publicPort) errors.push(`LOCAL_PORT and PORT are both ${c.publicPort}: the two listeners need different ports.`);
    if (WILDCARD.has(c.localHost)) {
      errors.push("LOCAL_HOST must be 127.0.0.1 or one specific LAN address of this PC, not 0.0.0.0 / :: (a wildcard bind listens on every interface).");
    } else if (!isLoopbackHost(c.localHost)) {
      warnings.push(`The local listener is bound to ${c.localHost}:${c.localPort}, so other devices on that network can reach it. Restrict it with the Windows Firewall rule in the README; the access key alone is not a network boundary.`);
    }
    if (c.localAccessKey.length < 16) warnings.push("The local access key is shorter than 16 characters. Use a long random value (for example 32+ hex characters).");
    if (c.localKeyIsLegacy) warnings.push("ACCESS_KEY is now used only by the local listener. Prefer LOCAL_ACCESS_KEY; the public dashboard never accepts it.");
  }

  return { errors, warnings };
}
