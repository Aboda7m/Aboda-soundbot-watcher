import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, readdir, stat, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { SECURITY_HEADERS, SNOWFLAKE } from "./common.ts";

/**
 * API over the recordings folder (guilds/<guildId>/.../<sessionId>/participants/<userId>_<n>.ogg).
 *
 *   GET  /api/recordings                         every recording the signed-in user may see (newest first)
 *   GET  /api/recordings/session?guild=&id=     one recording: its segments with precise offsets and durations
 *   GET  /api/recordings/audio?guild=&id=&file= one segment, streamed with Range support (&download=1 = attachment)
 *   POST /api/recordings/export?guild=&id=      mix selected segment files and return a synchronized MP3
 *
 * Safety: the tree is scanned by the server and every path used for reading comes from that scan, never from the
 * request. A request can only name a guild, a session id and a file name; these are matched against the scan, so
 * there is no way to reach another folder ("../", absolute paths, symlink tricks in names are all just "not found").
 * Only guilds in `kit.allowedGuildIds` are visible; anything else answers 404, exactly like a missing recording.
 */
export interface RecordingFiles {
  /** The recordings folder, i.e. the one that contains `guilds/`. */
  dir: string;
  /** FFmpeg executable used for synchronized MP3 exports. */
  ffmpegPath?: string;
  /** Used only to learn display names for ids that the manifests (older recordings) do not carry. */
  voiceActivityFile?: string;
  /** Live lookups, e.g. from the Discord client cache. All optional. */
  names?: {
    guild?(guildId: string): string | undefined;
    channel?(guildId: string, channelId: string): string | undefined;
    user?(userId: string): string | undefined;
  };
}

export interface RecordingRouteKit {
  json(res: ServerResponse, status: number, body: unknown): void;
  /** Guilds the signed-in user may see. Recordings of any other guild do not exist as far as they can tell. */
  allowedGuildIds: readonly string[];
}

// ---------- scanning ----------

const SESSION_NAME = /^\d{8}_\d{6}(?:_[0-9a-zA-Z]{3,16})?$/;
const AUDIO_FILE = /\.(?:ogg|opus)$/i;
const TRACK_NAME = /^(\d{15,25})(?:[_-](\d{1,6}))?\.(?:ogg|opus)$/i;
const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,140}$/;
const MAX_DEPTH = 6;
const MAX_SESSIONS = 5000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const INDEX_TTL_MS = 4000;
/** A manifest that still says "active" this long after the last write belongs to a crashed or killed bot. */
const STALE_ACTIVE_MS = 15 * 60_000;
const OPUS_PRE_SKIP = 312;
const execFileAsync = promisify(execFile);
const MAX_EXPORT_BODY = 512 * 1024;
const MAX_EXPORT_SEGMENTS = 500;
const MAX_EXPORT_SECONDS = 4 * 60 * 60;

interface RawTrack {
  name: string;
  userId: string | null;
  n: number | null;
  bytes: number;
  mtimeMs: number;
  birthtimeMs: number;
  /** Absolute path, from the scan only. */
  path: string;
}

interface RawSession {
  guildId: string;
  id: string;
  dir: string;
  manifest: Record<string, unknown> | null;
  tracks: RawTrack[];
  startedAtMs: number;
  lastWriteMs: number;
  /** Finished sessions never change, so their scan result can be reused without looking at the files again. */
  final: boolean;
  signature: string;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

function idToTime(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(id);
  if (!m) return null;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return Number.isNaN(t) ? null : t;
}

const asTime = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const asString = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

async function readManifest(dir: string): Promise<{ data: Record<string, unknown> | null; mtimeMs: number }> {
  try {
    const file = join(dir, "manifest.json");
    const info = await stat(file);
    if (info.size > MAX_MANIFEST_BYTES) return { data: null, mtimeMs: info.mtimeMs };
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const data = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    return { data, mtimeMs: info.mtimeMs };
  } catch {
    return { data: null, mtimeMs: 0 };
  }
}

/** The manifest's per-segment records, tolerating any shape (old, new, damaged). */
function participantsOf(manifest: Record<string, unknown> | null): Record<string, unknown>[] {
  const outputs = manifest?.outputs;
  const list = typeof outputs === "object" && outputs !== null ? (outputs as Record<string, unknown>).participants : null;
  return Array.isArray(list) ? list.filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null) : [];
}

const sessionCache = new Map<string, RawSession>();

async function readSession(guildId: string, dir: string, now: number): Promise<RawSession | null> {
  const id = basename(dir);
  const audioDir = (await exists(join(dir, "participants"))) ? join(dir, "participants") : dir;
  let dirInfo, audioInfo;
  try {
    dirInfo = await stat(dir);
    audioInfo = await stat(audioDir);
  } catch {
    return null;
  }
  const manifestFile = await stat(join(dir, "manifest.json")).catch(() => null);
  const signature = `${dirInfo.mtimeMs}|${audioInfo.mtimeMs}|${manifestFile?.mtimeMs ?? 0}`;
  const cached = sessionCache.get(dir);
  if (cached && cached.final && cached.signature === signature) return cached;

  const { data: manifest } = await readManifest(dir);

  const tracks: RawTrack[] = [];
  let entries: string[] = [];
  try {
    entries = (await readdir(audioDir, { withFileTypes: true })).filter((e) => e.isFile() && AUDIO_FILE.test(e.name)).map((e) => e.name);
  } catch {
    // no audio folder: a recording with nothing in it
  }
  const infos = await Promise.all(entries.map((name) => stat(join(audioDir, name)).then((s) => ({ name, s }), () => null)));
  for (const item of infos) {
    if (!item || !SAFE_FILE.test(item.name)) continue; // names we could not safely address are simply not offered
    const m = TRACK_NAME.exec(item.name);
    tracks.push({
      name: item.name,
      userId: m ? m[1]! : null,
      n: m && m[2] ? Number(m[2]) : null,
      bytes: item.s.size,
      mtimeMs: item.s.mtimeMs,
      birthtimeMs: item.s.birthtimeMs,
      path: join(audioDir, item.name),
    });
  }

  const lastWriteMs = Math.max(dirInfo.mtimeMs, manifestFile?.mtimeMs ?? 0, ...tracks.map((t) => t.mtimeMs));
  const earliestFile = tracks.length ? Math.min(...tracks.map((t) => (t.birthtimeMs > 0 ? t.birthtimeMs : t.mtimeMs))) : null;
  const startedAtMs = asTime(manifest?.startedAt) ?? idToTime(id) ?? earliestFile ?? dirInfo.birthtimeMs ?? dirInfo.mtimeMs;
  const status = asString(manifest?.status);
  const final = status === "completed" || status === "interrupted" || now - lastWriteMs > STALE_ACTIVE_MS;

  const raw: RawSession = { guildId, id, dir, manifest, tracks, startedAtMs, lastWriteMs, final, signature };
  sessionCache.set(dir, raw);
  return raw;
}

/**
 * Walks guilds/<guildId>/ and finds session folders wherever they are: any folder named like a session id, or holding
 * a manifest.json or a participants folder. Extra folders, stray files and half-written sessions are skipped, not fatal.
 */
async function scanTree(root: string, now: number): Promise<RawSession[]> {
  const guildsRoot = (await exists(join(root, "guilds"))) ? join(root, "guilds") : root;
  let guildDirs;
  try {
    guildDirs = await readdir(guildsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: { guildId: string; dir: string }[] = [];
  const walk = async (guildId: string, dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const looksLikeSession =
      SESSION_NAME.test(basename(dir)) ||
      entries.some((e) => (e.isFile() && e.name === "manifest.json") || (e.isDirectory() && e.name === "participants"));
    if (looksLikeSession && depth > 0) {
      found.push({ guildId, dir });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) if (e.isDirectory()) await walk(guildId, join(dir, e.name), depth + 1);
  };

  for (const g of guildDirs) {
    if (g.isDirectory() && SNOWFLAKE.test(g.name)) await walk(g.name, join(guildsRoot, g.name), 0);
  }

  const out: RawSession[] = [];
  const seen = new Set<string>();
  // Bounded parallelism: a big archive must not open thousands of files at once.
  for (let i = 0; i < found.length; i += 16) {
    const batch = await Promise.all(found.slice(i, i + 16).map((f) => readSession(f.guildId, f.dir, now)));
    for (const s of batch) {
      if (!s) continue;
      const key = `${s.guildId}/${s.id}`;
      if (seen.has(key)) continue; // the same session id twice (copied folder): first one wins
      seen.add(key);
      out.push(s);
    }
  }
  for (const dir of sessionCache.keys()) if (!found.some((f) => f.dir === dir)) sessionCache.delete(dir);
  return out.sort((a, b) => b.startedAtMs - a.startedAtMs);
}

const indexCache = new Map<string, { at: number; sessions: RawSession[] }>();

async function sessions(files: RecordingFiles, force = false): Promise<RawSession[]> {
  const now = Date.now();
  const hit = indexCache.get(files.dir);
  if (!force && hit && now - hit.at < INDEX_TTL_MS) return hit.sessions;
  const list = await scanTree(files.dir, now);
  indexCache.set(files.dir, { at: now, sessions: list });
  return list;
}

// ---------- names ----------

interface VoiceNames {
  users: Map<string, string>;
  guilds: Map<string, string>;
}
const voiceNameCache = new Map<string, { mtimeMs: number; size: number; names: VoiceNames }>();
const MAX_VOICE_LOG_BYTES = 64 * 1024 * 1024;

/** Names the existing voice-activity log has already recorded for user and guild ids. Best effort; never an error. */
async function loadVoiceNames(file: string | undefined): Promise<VoiceNames> {
  const empty: VoiceNames = { users: new Map(), guilds: new Map() };
  if (!file) return empty;
  try {
    const info = await stat(file);
    if (info.size > MAX_VOICE_LOG_BYTES) return empty;
    const hit = voiceNameCache.get(file);
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.names;
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const names: VoiceNames = { users: new Map(), guilds: new Map() };
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (typeof e !== "object" || e === null) continue;
        const r = e as Record<string, unknown>;
        const uid = asString(r.userId, 30);
        const uname = asString(r.username);
        const gid = asString(r.guildId, 30);
        const gname = asString(r.guildName);
        if (uid && uname) names.users.set(uid, uname); // later entries win: the most recent name
        if (gid && gname) names.guilds.set(gid, gname);
      }
    }
    voiceNameCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, names });
    return names;
  } catch {
    return empty;
  }
}

interface Resolver {
  guild(guildId: string, fromManifest?: string): string | null;
  channel(guildId: string, channelId: string | undefined, fromManifest?: string): string | null;
  user(userId: string | null | undefined, fromManifest?: string): string | null;
}

// A name written into the manifest at record time wins (it is what the person was called then); live Discord
// names fill the gaps for older recordings, then the voice-activity log.
function makeResolver(files: RecordingFiles, voice: VoiceNames): Resolver {
  const safe = <T>(fn: () => T | undefined): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  return {
    guild: (id, m) => m || safe(() => files.names?.guild?.(id)) || voice.guilds.get(id) || null,
    channel: (gid, cid, m) => m || (cid ? safe(() => files.names?.channel?.(gid, cid)) : undefined) || null,
    user: (id, m) => m || (id ? safe(() => files.names?.user?.(id)) || voice.users.get(id) : undefined) || null,
  };
}

// ---------- output shapes ----------

type Status = "completed" | "interrupted" | "active" | "incomplete" | "unknown";

function statusOf(s: RawSession, now: number): Status {
  const v = asString(s.manifest?.status);
  if (v === "completed" || v === "interrupted") return v;
  // The recorder writes a manifest the moment a recording starts, so a folder without a usable one is an old,
  // copied or damaged recording, never a live one (its file times may be recent only because it was moved).
  if (!s.manifest) return "unknown";
  if (v === "active") return now - s.lastWriteMs > STALE_ACTIVE_MS ? "incomplete" : "active"; // else: a bot that died mid-recording
  return "unknown";
}

/** Longest believable recording; anything longer means the file times are not the real ones (e.g. a copied folder). */
const MAX_GUESSED_SEC = 12 * 3600;

function summarize(s: RawSession, r: Resolver, now: number) {
  const status = statusOf(s, now);
  const manifestEnd = asTime(s.manifest?.endedAt);
  const manifestDuration = typeof s.manifest?.durationSeconds === "number" && s.manifest.durationSeconds >= 0 ? s.manifest.durationSeconds : null;
  const lastAudioMs = s.tracks.length ? Math.max(...s.tracks.map((t) => t.mtimeMs)) : null;

  let durationSec: number | null;
  let endedAtMs: number | null;
  if (status === "active") {
    durationSec = Math.max(0, Math.round(((now - s.startedAtMs) / 1000) * 1000) / 1000);
    endedAtMs = null;
  } else if (status === "completed" && manifestDuration !== null) {
    const preciseDuration = manifestEnd === null ? manifestDuration : (manifestEnd - s.startedAtMs) / 1000;
    durationSec = Math.max(0, Math.round(preciseDuration * 1000) / 1000);
    endedAtMs = manifestEnd ?? s.startedAtMs + manifestDuration * 1000;
  } else {
    // interrupted / incomplete / unknown: the best evidence is when the last audio was written
    const end = manifestEnd ?? lastAudioMs;
    const guess = end === null ? null : (end - s.startedAtMs) / 1000;
    const believable = guess !== null && guess >= 0 && guess <= MAX_GUESSED_SEC;
    durationSec = believable ? Math.round(guess * 1000) / 1000 : null;
    endedAtMs = believable ? end : null;
  }

  const manifestNames = new Map<string, string>();
  for (const rec of participantsOf(s.manifest)) {
    const uid = asString(rec.userId, 30);
    const name = asString(rec.username);
    if (uid && name && !manifestNames.has(uid)) manifestNames.set(uid, name);
  }

  const bySpeaker = new Map<string, { id: string | null; name: string | null; segments: number; bytes: number }>();
  for (const t of s.tracks) {
    const key = t.userId ?? "unknown";
    const cur = bySpeaker.get(key) ?? { id: t.userId, name: r.user(t.userId, t.userId ? manifestNames.get(t.userId) : undefined), segments: 0, bytes: 0 };
    cur.segments++;
    cur.bytes += t.bytes;
    bySpeaker.set(key, cur);
  }

  const initiator = asString(s.manifest?.initiatedBy, 30) ?? null;
  const channelId = asString(s.manifest?.channelId, 30);
  return {
    id: s.id,
    guildId: s.guildId,
    guildName: r.guild(s.guildId, asString(s.manifest?.guildName)),
    channelId: channelId ?? null,
    channelName: r.channel(s.guildId, channelId, asString(s.manifest?.channelName)),
    startedAt: new Date(s.startedAtMs).toISOString(),
    endedAt: endedAtMs === null ? null : new Date(endedAtMs).toISOString(),
    durationSec,
    status,
    initiatedBy: initiator ? { id: initiator, name: r.user(initiator, asString(s.manifest?.initiatedByName) ?? manifestNames.get(initiator)) } : null,
    speakers: [...bySpeaker.values()].sort((a, b) => b.bytes - a.bytes),
    segments: s.tracks.length,
    bytes: s.tracks.reduce((sum, t) => sum + t.bytes, 0),
  };
}

// ---------- segment duration (read from the Ogg stream itself) ----------

const durationCache = new Map<string, number | null>();

/** The last Ogg page's granule position is the sample count: cheap to read, no decoding. */
async function oggDurationSec(t: RawTrack): Promise<number | null> {
  const key = `${t.path}|${t.mtimeMs}|${t.bytes}`;
  if (durationCache.has(key)) return durationCache.get(key)!;
  let result: number | null = null;
  try {
    const fh = await open(t.path, "r");
    try {
      const len = Math.min(t.bytes, 8192);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, t.bytes - len);
      const at = len >= 27 ? buf.lastIndexOf("OggS", len - 27, "ascii") : -1;
      if (at >= 0 && at + 14 <= len) {
        const granule = buf.readBigUInt64LE(at + 6);
        if (granule < 0x7fffffffffffffffn) result = Math.max(0, Number(granule - BigInt(OPUS_PRE_SKIP)) / 48000);
      }
    } finally {
      await fh.close();
    }
  } catch {
    result = null;
  }
  if (durationCache.size > 20000) durationCache.clear();
  durationCache.set(key, result);
  return result;
}

// ---------- the routes ----------

function findSession(list: RawSession[], guildId: string, id: string, kit: RecordingRouteKit): RawSession | null {
  if (!kit.allowedGuildIds.includes(guildId)) return null;
  return list.find((s) => s.guildId === guildId && s.id === id) ?? null;
}

const asciiName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "recording";

function serveAudio(req: IncomingMessage, res: ServerResponse, track: RawTrack, downloadName: string | null): void {
  const size = track.bytes;
  const headers: Record<string, string | number> = {
    ...SECURITY_HEADERS,
    "Cache-Control": "private, no-cache",
    "Content-Type": "audio/ogg",
    "Accept-Ranges": "bytes",
  };
  if (downloadName) headers["Content-Disposition"] = `attachment; filename="${asciiName(downloadName)}.ogg"`;

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = typeof req.headers.range === "string" ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null;
  if (range && (range[1] || range[2])) {
    if (range[1] === "") {
      start = Math.max(0, size - Number(range[2])); // "last N bytes"
    } else {
      start = Number(range[1]);
      if (range[2]) end = Math.min(size - 1, Number(range[2]));
    }
    if (size === 0 || start > end || start >= size) {
      res.writeHead(416, { ...SECURITY_HEADERS, "Content-Range": `bytes */${size}` }).end();
      return;
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  if (size === 0) {
    res.writeHead(200, { ...headers, "Content-Length": 0 }).end();
    return;
  }
  headers["Content-Length"] = end - start + 1;
  res.writeHead(status, headers);
  const stream = createReadStream(track.path, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_EXPORT_BODY) throw Object.assign(new Error("Export request is too large."), { status: 413 });
    chunks.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
}

function finiteRange(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function exportMp3(
  files: RecordingFiles,
  session: RawSession,
  selectedFiles: string[],
  rangeStart: number,
  rangeEnd: number,
  res: ServerResponse,
): Promise<void> {
  if (!files.ffmpegPath) throw Object.assign(new Error("MP3 export is not configured."), { status: 503 });
  const wanted = new Set(selectedFiles);
  const chosen = session.tracks.filter((t) => wanted.has(t.name));
  if (!chosen.length || chosen.length !== wanted.size) throw Object.assign(new Error("One or more selected audio parts are unavailable."), { status: 404 });
  if (chosen.length > MAX_EXPORT_SEGMENTS) throw Object.assign(new Error(`Select no more than ${MAX_EXPORT_SEGMENTS} audio parts.`), { status: 400 });

  const { data: manifest } = await readManifest(session.dir);
  const starts = new Map<string, number>();
  for (const rec of participantsOf(manifest)) {
    const file = asString(rec.file, 300);
    const started = asTime(rec.startedAt);
    if (file && started !== null) starts.set(basename(file), started);
  }

  const clips: { path: string; offset: number; duration: number; file: string }[] = [];
  for (const track of chosen) {
    const duration = await oggDurationSec(track);
    if (duration === null || duration <= 0) continue;
    const started = starts.get(track.name) ?? (track.birthtimeMs > 0 ? track.birthtimeMs : track.mtimeMs - duration * 1000);
    const offset = Math.max(0, (started - session.startedAtMs) / 1000);
    if (offset < rangeEnd && offset + duration > rangeStart) clips.push({ path: track.path, offset, duration, file: track.name });
  }
  if (!clips.length) throw Object.assign(new Error("No selected audio overlaps this time range."), { status: 422 });

  const workDir = await mkdtemp(join(tmpdir(), "aboda-recording-export-"));
  const output = join(workDir, "recording.mp3");
  try {
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-threads", "1"];
    for (const clip of clips) args.push("-i", clip.path);
    const filters: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]!;
      const localStart = Math.max(0, rangeStart - clip.offset);
      const localEnd = Math.min(clip.duration, rangeEnd - clip.offset);
      const delay = Math.max(0, Math.round((clip.offset - rangeStart) * 1000));
      if (localEnd <= localStart) continue;
      filters.push(`[${i}:a]atrim=start=${localStart.toFixed(3)}:end=${localEnd.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delay}|${delay}[a${i}]`);
    }
    const labels = clips.map((_, i) => `[a${i}]`).join("");
    filters.push(`${labels}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0,apad=pad_dur=${(rangeEnd - rangeStart).toFixed(3)},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,alimiter=limit=0.95[out]`);
    args.push(
      "-filter_complex", filters.join(";"), "-map", "[out]", "-t", (rangeEnd - rangeStart).toFixed(3),
      "-vn", "-sn", "-dn", "-map_metadata", "-1", "-ar", "48000", "-ac", "2",
      "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3", output,
    );
    try {
      await execFileAsync(files.ffmpegPath, args, {
        timeout: Math.min(15 * 60_000, Math.max(60_000, (rangeEnd - rangeStart) * 3000)),
        killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      });
    } catch (err) {
      console.error("Recording MP3 export failed:", err instanceof Error ? err.message : err);
      throw Object.assign(new Error("FFmpeg could not mix this recording. Check that FFmpeg includes the MP3 encoder (libmp3lame)."), { status: 422 });
    }
    const info = await stat(output);
    if (!info.size) throw Object.assign(new Error("FFmpeg produced an empty MP3."), { status: 422 });
    const downloadName = `${session.id}_mix.mp3`;
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": info.size,
      "Content-Disposition": `attachment; filename="${downloadName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const stream = createReadStream(output);
    const cleanup = () => { stream.destroy(); void rm(workDir, { recursive: true, force: true }); };
    res.once("close", cleanup);
    res.once("finish", () => void rm(workDir, { recursive: true, force: true }));
    stream.once("error", () => res.destroy());
    stream.pipe(res);
  } catch (err) {
    await rm(workDir, { recursive: true, force: true });
    throw err;
  }
}

/** Returns true if the request was one of ours (and has been answered). */
export async function handleRecordingRoute(
  files: RecordingFiles,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  kit: RecordingRouteKit,
): Promise<boolean> {
  const path = url.pathname;
  const isExport = path === "/api/recordings/export" && req.method === "POST";
  if ((!isExport && req.method !== "GET") || (path !== "/api/recordings" && path !== "/api/recordings/session" && path !== "/api/recordings/audio" && !isExport)) return false;

  const notFound = () => kit.json(res, 404, { error: "Recording not found." });

  try {
    const now = Date.now();
    const voice = await loadVoiceNames(files.voiceActivityFile);
    const resolver = makeResolver(files, voice);

    if (path === "/api/recordings") {
      const all = (await sessions(files)).filter((s) => kit.allowedGuildIds.includes(s.guildId));
      const shown = all.slice(0, MAX_SESSIONS);
      kit.json(res, 200, {
        total: all.length,
        truncated: all.length > shown.length,
        serverTime: new Date(now).toISOString(),
        sessions: shown.map((s) => summarize(s, resolver, now)),
      });
      return true;
    }

    const guildId = url.searchParams.get("guild") ?? "";
    const id = url.searchParams.get("id") ?? "";
    if (!SNOWFLAKE.test(guildId) || !SAFE_ID.test(id)) {
      kit.json(res, 400, { error: "guild and id are required" });
      return true;
    }

    let session = findSession(await sessions(files), guildId, id, kit);
    if (!session) session = findSession(await sessions(files, true), guildId, id, kit); // maybe it was created a moment ago
    if (!session) {
      notFound();
      return true;
    }

    if (isExport) {
      if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
        kit.json(res, 415, { error: "Content-Type must be application/json" });
        return true;
      }
      const parsedBody = await readJsonBody(req);
      if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
        kit.json(res, 400, { error: "Invalid export request." });
        return true;
      }
      const body = parsedBody as Record<string, unknown>;
      const filesToExport = Array.isArray(body.files) ? body.files.filter((v): v is string => typeof v === "string" && SAFE_FILE.test(v)) : [];
      if (!filesToExport.length || filesToExport.length !== (Array.isArray(body.files) ? body.files.length : 0)) {
        kit.json(res, 400, { error: "Choose at least one valid audio part." });
        return true;
      }
      const rangeStart = finiteRange(body.startSec, 0);
      const manifestEnd = asTime(session.manifest?.endedAt);
      const manifestDuration = typeof session.manifest?.durationSeconds === "number" ? session.manifest.durationSeconds : null;
      const lastFileEnd = session.tracks.length ? (Math.max(...session.tracks.map((t) => t.mtimeMs)) - session.startedAtMs) / 1000 : 1;
      const defaultEnd = manifestEnd !== null ? (manifestEnd - session.startedAtMs) / 1000 : manifestDuration ?? Math.max(1, lastFileEnd);
      const rangeEnd = finiteRange(body.endSec, defaultEnd);
      if (rangeStart < 0 || rangeEnd <= rangeStart || rangeEnd - rangeStart > MAX_EXPORT_SECONDS) {
        kit.json(res, 400, { error: `Choose a valid range up to ${MAX_EXPORT_SECONDS / 3600} hours.` });
        return true;
      }
      const sessionDuration = summarize(session, resolver, now).durationSec;
      if (sessionDuration !== null && rangeEnd > sessionDuration + 0.25) {
        kit.json(res, 400, { error: "The export range extends beyond this recording." });
        return true;
      }
      await exportMp3(files, session, filesToExport, rangeStart, rangeEnd, res);
      return true;
    }

    if (path === "/api/recordings/audio") {
      const file = url.searchParams.get("file") ?? "";
      const track = SAFE_FILE.test(file) ? session.tracks.find((t) => t.name === file) : undefined;
      if (!track) {
        notFound();
        return true;
      }
      const who = resolver.user(track.userId) ?? track.userId ?? "speaker";
      serveAudio(req, res, track, url.searchParams.get("download") === "1" ? `${session.id}_${who}_${track.n ?? 0}` : null);
      return true;
    }

    // ---- session detail
    const summary = summarize(session, resolver, now);
    const manifestTracks = new Map<string, { startedAt: number | null; username?: string }>();
    for (const rec of participantsOf(session.manifest)) {
      const file = asString(rec.file, 300);
      if (file) manifestTracks.set(basename(file), { startedAt: asTime(rec.startedAt), username: asString(rec.username) });
    }

    const tracks = await Promise.all(
      session.tracks.map(async (t) => {
        const durationSec = await oggDurationSec(t);
        const m = manifestTracks.get(t.name);
        // Start of the segment: the manifest's time, else when the file was created (Windows keeps this), else end minus length.
        const startMs = m?.startedAt ?? (t.birthtimeMs > 0 ? t.birthtimeMs : t.mtimeMs - (durationSec ?? 0) * 1000);
        return {
          file: t.name,
          userId: t.userId,
          username: resolver.user(t.userId, m?.username),
          n: t.n,
          bytes: t.bytes,
          durationSec: durationSec === null ? null : Math.round(durationSec * 1000) / 1000,
          startedAt: new Date(startMs).toISOString(),
          offsetSec: Math.max(0, Math.round(((startMs - session.startedAtMs) / 1000) * 1000) / 1000),
        };
      }),
    );
    tracks.sort((a, b) => a.offsetSec - b.offsetSec || a.file.localeCompare(b.file));
    kit.json(res, 200, { session: summary, tracks });
  } catch (err) {
    const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status >= 500 && status !== 503) console.error("Recordings route error:", err);
    kit.json(res, status, { error: err instanceof Error && status < 500 ? err.message : status === 503 ? "MP3 export is unavailable on this server." : "Could not process the recording request." });
  }
  return true;
}
