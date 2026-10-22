import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream, readdirSync, rmSync, mkdirSync } from "node:fs";
import { copyFile, link, rename, rm, stat, statfs, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import { checkName, cleanUploadName, suggestName } from "./names.ts";
import { DURATION_EPSILON, resolveTrim, type TrimPlan } from "./trim.ts";
import { defaultYtDlpPath } from "../tools/ytdlp.ts";

export const EXT_DEMUXER: Record<string, string> = {
  ".mp3": "mp3", ".wav": "wav", ".ogg": "ogg", ".oga": "ogg", ".opus": "ogg", ".flac": "flac", ".aac": "aac",
  ".aif": "aiff", ".aiff": "aiff", ".wma": "asf", ".wmv": "asf", ".avi": "avi",
  ".m4a": "mov", ".mp4": "mov", ".m4v": "mov", ".mov": "mov", ".3gp": "mov",
  ".mkv": "matroska", ".mka": "matroska", ".webm": "matroska", ".weba": "matroska",
};
export const UPLOAD_EXTENSIONS = Object.keys(EXT_DEMUXER);
const ALL_DEMUXERS = [...new Set(Object.values(EXT_DEMUXER))];

const PROBE_TIMEOUT_MS = 15_000;
const STAGED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGED_FILE = /^[0-9a-f-]{36}\.(src|part|out\d+\.\w+|\.src\..*)$/;
const MIN_AUDIO_SEC = 0.05;

const ALLOWED_YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

function validateYouTubeUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new ImportError(400, "Invalid URL format.");
  }
  if (parsed.protocol !== "https:") {
    throw new ImportError(400, "Only secure HTTPS YouTube URLs are supported.");
  }
  if (parsed.username || parsed.password) {
    throw new ImportError(400, "URLs with credentials are not allowed.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_YOUTUBE_HOSTS.has(hostname)) {
    throw new ImportError(400, "Only official YouTube domains (youtube.com, youtu.be) are permitted.");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new ImportError(400, "Non-standard ports are not allowed.");
  }
  return parsed;
}

export class ImportError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ImportError";
    this.status = status;
  }
}

export interface ImportOptions {
  library: Pick<SoundLibrary, "list" | "invalidate">;
  soundsDir: string;
  acceptedExtensions: string[];
  stagingDir: string;
  maxUploadBytes: number;
  maxOutputSec: number;
  defaultTrimSec: number;
  maxOutputBytes: number;
  processTimeoutMs: number;
  ffmpegPath: string;
  ffprobePath: string;
  ttlMs?: number;
  maxStaged?: number;
  freeSpace?(dir: string): Promise<number | null>;
  log?(message: string, err?: unknown): void;
}

interface Probe {
  format: string;
  codec: string;
  audioIndex: number | null;
  durationSec: number | null;
  sampleRate: number | null;
  channels: number | null;
  audioStreams: number;
  hasVideo: boolean;
}

interface Staged {
  id: string;
  srcPath: string;
  probe: Probe;
  outPath: string;
  ext: string;
  mime: string;
  sizeBytes: number;
  version: number;
  touchedAt: number;
  busy: boolean;
  saving: boolean;
}

export interface RenderResult {
  version: number;
  mode: TrimPlan["mode"];
  startSec: number;
  endSec: number;
  durationSec: number;
  extension: string;
  sizeBytes: number;
  sampleRate: number | null;
  channels: number | null;
  converted: boolean;
  note: string;
}

export interface StagedInfo {
  id: string;
  suggestedName: string;
  nameTaken: boolean;
  original: {
    fileName: string;
    sizeBytes: number;
    format: string;
    codec: string;
    durationSec: number | null;
    hasVideo: boolean;
    audioStreams: number;
  };
  result: RenderResult;
}

const MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav" };
const lower = (s: string) => s.normalize("NFC").toLowerCase();
const fmtSec = (s: number) => s.toFixed(3);

function run(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })),
    );
  });
}

function parseNames(text: string, flagPattern: RegExp, mustHave: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t.length < 2 || !flagPattern.test(t[0]!) || !t[0]!.includes(mustHave)) continue;
    for (const n of t[1]!.split(",")) names.add(n);
  }
  return names;
}

async function defaultFreeSpace(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export class ImportService {
  #o: ImportOptions;
  #staged = new Map<string, Staged>();
  #uploading = 0;
  #busy = false;
  #toolsOk = false;
  #demuxers: string[] = ALL_DEMUXERS;
  #extensions: string[] = UPLOAD_EXTENSIONS;
  #timer: NodeJS.Timeout;
  #outExt: string | null;
  #wantsOut: boolean;

  constructor(opts: ImportOptions) {
    this.#o = { ...opts, defaultTrimSec: Math.min(opts.defaultTrimSec, opts.maxOutputSec) };
    const accepted = opts.acceptedExtensions.map((e) => e.toLowerCase());
    this.#wantsOut = accepted.includes(".mp3") || accepted.includes(".wav");
    this.#outExt = this.#wantsOut ? (accepted.includes(".mp3") ? ".mp3" : ".wav") : null;
    mkdirSync(opts.stagingDir, { recursive: true });
    for (const f of readdirSync(opts.stagingDir)) {
      if (STAGED_FILE.test(f)) rmSync(join(opts.stagingDir, f), { force: true });
    }
    this.#timer = setInterval(() => this.#sweep(), 60_000);
    this.#timer.unref();
  }

  limits() {
    return {
      maxUploadBytes: this.#o.maxUploadBytes,
      maxOutputSec: this.#o.maxOutputSec,
      defaultTrimSec: this.#o.defaultTrimSec,
      extensions: this.#extensions,
      outputExtension: this.#outExt,
    };
  }

  async status(): Promise<{ ready: boolean; problem?: string }> {
    if (!this.#wantsOut) return { ready: false, problem: "ACCEPTED_EXTENSIONS must include .mp3 or .wav for imports to work." };
    try {
      await this.#ensureTools();
      return { ready: true };
    } catch (err) {
      return { ready: false, problem: (err as Error).message };
    }
  }

  async #ensureTools(): Promise<void> {
    if (this.#toolsOk) return;
    for (const [cmd, label] of [[this.#o.ffprobePath, "ffprobe"], [this.#o.ffmpegPath, "ffmpeg"]] as const) {
      try {
        await run(cmd, ["-version"], 5_000);
      } catch (err) {
        this.#o.log?.(`${label} check failed`, err);
        throw new ImportError(503, `${label} was not found on the server. Install FFmpeg (or set FFMPEG_PATH / FFPROBE_PATH).`);
      }
    }
    let demuxers: Set<string>;
    let encoders: Set<string>;
    try {
      demuxers = parseNames((await run(this.#o.ffmpegPath, ["-hide_banner", "-demuxers"], 10_000)).stdout, /^[DE]+$/, "D");
      encoders = parseNames((await run(this.#o.ffmpegPath, ["-hide_banner", "-encoders"], 10_000)).stdout, /^[AVS][.\w]{5}$/, "A");
    } catch (err) {
      this.#o.log?.("ffmpeg capability check failed", err);
      throw new ImportError(503, "Could not ask FFmpeg which formats it supports.");
    }
    const demux = ALL_DEMUXERS.filter((d) => demuxers.has(d));
    if (!demux.length) throw new ImportError(503, "This FFmpeg build cannot read any of the supported audio/video formats.");
    const accepted = this.#o.acceptedExtensions.map((e) => e.toLowerCase());
    let out: string | null = null;
    if (accepted.includes(".mp3") && encoders.has("libmp3lame")) out = ".mp3";
    else if (accepted.includes(".wav") && encoders.has("pcm_s16le")) out = ".wav";
    if (!out)
      throw new ImportError(
        503,
        accepted.includes(".mp3")
          ? "This FFmpeg build has no MP3 encoder (libmp3lame). Install a full FFmpeg build or add .wav to ACCEPTED_EXTENSIONS."
          : "This FFmpeg build has no WAV (pcm_s16le) encoder.",
      );
    this.#demuxers = demux;
    this.#extensions = UPLOAD_EXTENSIONS.filter((e) => demux.includes(EXT_DEMUXER[e]!));
    this.#outExt = out;
    this.#toolsOk = true;
  }

  async stage(body: Readable, rawFileName: string, declaredLength: number | null): Promise<StagedInfo> {
    this.#sweep();
    const fileName = cleanUploadName(rawFileName);
    await this.#ensureTools();
    const ext = extname(fileName).toLowerCase();
    if (!this.#extensions.includes(ext))
      throw new ImportError(415, `Unsupported file type${ext ? ` "${ext}"` : ""}. Supported: ${this.#extensions.join(", ")}.`);
    if (declaredLength !== null && declaredLength <= 0) throw new ImportError(400, "The file is empty.");
    if (declaredLength !== null && declaredLength > this.#o.maxUploadBytes) throw this.#tooLarge();
    if (this.#staged.size + this.#uploading >= (this.#o.maxStaged ?? 3))
      throw new ImportError(429, "Too many pending imports. Save or discard one first.");
    await this.#checkDisk(declaredLength);

    const id = randomUUID();
    const srcPath = join(this.#o.stagingDir, `${id}.src`);
    this.#uploading++;
    try {
      await this.#receive(body, srcPath);
      return await this.#exclusive(async () => {
        const probe = await this.#probe(srcPath);
        this.#validateSource(probe);
        const trim = resolveTrim({ mode: "first" }, probe.durationSec, this.#trimLimits());
        if (!trim.ok) throw new ImportError(422, trim.error);
        const r = await this.#render(id, srcPath, probe, trim.plan, 1);
        this.#staged.set(id, {
          id, srcPath, probe, outPath: r.path, ext: r.result.extension, mime: MIME[r.result.extension] ?? "application/octet-stream",
          sizeBytes: r.result.sizeBytes, version: 1, touchedAt: Date.now(), busy: false, saving: false,
        });
        const suggested = suggestName(fileName);
        return {
          id,
          suggestedName: suggested,
          nameTaken: suggested !== "" && this.#taken(suggested),
          original: {
            fileName,
            sizeBytes: (await stat(srcPath)).size,
            format: probe.format,
            codec: probe.codec,
            durationSec: probe.durationSec,
            hasVideo: probe.hasVideo,
            audioStreams: probe.audioStreams,
          },
          result: r.result,
        };
      });
    } catch (err) {
      await rm(srcPath, { force: true });
      throw err;
    } finally {
      this.#uploading--;
    }
  }

  async importYouTube(urlString: string): Promise<StagedInfo> {
    this.#sweep();
    await this.#ensureTools();
    const validatedUrl = validateYouTubeUrl(urlString);

    if (this.#staged.size + this.#uploading >= (this.#o.maxStaged ?? 3)) {
      throw new ImportError(429, "Too many pending imports. Save or discard one first.");
    }
    await this.#checkDisk(null);

    const id = randomUUID();
    const outTemplate = join(this.#o.stagingDir, `${id}.src.%(ext)s`);
    const ytDlpPath = defaultYtDlpPath();

    this.#uploading++;
    try {
      await run(
        ytDlpPath,
        [
          "--no-config",
          "--no-playlist",
          "--max-filesize", String(this.#o.maxUploadBytes),
          "-f", "bestaudio/best",
          "-o", outTemplate,
          validatedUrl.toString(),
        ],
        120_000,
      );

      const prefix = `${id}.src.`;
      const matched = readdirSync(this.#o.stagingDir).filter((f) => f.startsWith(prefix));
      if (matched.length === 0) {
        throw new ImportError(422, "yt-dlp finished but no output file was found.");
      }
      const srcName = matched[0]!;
      const srcPath = join(this.#o.stagingDir, srcName);

      return await this.#exclusive(async () => {
        const probe = await this.#probe(srcPath);
        this.#validateSource(probe);
        const trim = resolveTrim({ mode: "first" }, probe.durationSec, this.#trimLimits());
        if (!trim.ok) throw new ImportError(422, trim.error);
        const r = await this.#render(id, srcPath, probe, trim.plan, 1);
        this.#staged.set(id, {
          id, srcPath, probe, outPath: r.path, ext: r.result.extension, mime: MIME[r.result.extension] ?? "application/octet-stream",
          sizeBytes: r.result.sizeBytes, version: 1, touchedAt: Date.now(), busy: false, saving: false,
        });
        const suggested = suggestName(srcName);
        return {
          id,
          suggestedName: suggested,
          nameTaken: suggested !== "" && this.#taken(suggested),
          original: {
            fileName: srcName,
            sizeBytes: (await stat(srcPath)).size,
            format: probe.format,
            codec: probe.codec,
            durationSec: probe.durationSec,
            hasVideo: probe.hasVideo,
            audioStreams: probe.audioStreams,
          },
          result: r.result,
        };
      });
    } catch (err) {
      if (err instanceof ImportError) throw err;
      this.#o.log?.("YouTube download failed", err);
      throw new ImportError(422, `Failed to download from YouTube: ${(err as Error).message}`);
    } finally {
      this.#uploading--;
    }
  }

  async process(id: string, rawRequest: unknown): Promise<RenderResult> {
    const s = this.#get(id);
    if (s.saving || s.busy) throw new ImportError(409, "This import is busy. Try again in a moment.");
    s.touchedAt = Date.now();
    return await this.#exclusive(async () => {
      s.busy = true;
      let fresh: { path: string; result: RenderResult } | null = null;
      try {
        const trim = resolveTrim(rawRequest, s.probe.durationSec, this.#trimLimits());
        if (!trim.ok) throw new ImportError(400, trim.error);
        fresh = await this.#render(id, s.srcPath, s.probe, trim.plan, s.version + 1);
        if (this.#staged.get(id) !== s) throw new ImportError(404, "That import expired. Upload the file again.");
        const old = s.outPath;
        s.outPath = fresh.path;
        s.ext = fresh.result.extension;
        s.mime = MIME[s.ext] ?? "application/octet-stream";
        s.sizeBytes = fresh.result.sizeBytes;
        s.version += 1;
        s.touchedAt = Date.now();
        await rm(old, { force: true }).catch(() => {});
        return fresh.result;
      } catch (err) {
        if (fresh && s.outPath !== fresh.path) await rm(fresh.path, { force: true });
        throw err;
      } finally {
        s.busy = false;
      }
    });
  }

  preview(id: string): { path: string; mime: string; sizeBytes: number } | null {
    const s = STAGED_ID.test(id) ? this.#staged.get(id) : undefined;
    return s ? { path: s.outPath, mime: s.mime, sizeBytes: s.sizeBytes } : null;
  }

  async save(id: string, rawName: unknown): Promise<{ name: string; file: string }> {
    const s = this.#get(id);
    const checked = checkName(rawName);
    if (!checked.ok) throw new ImportError(400, checked.error);
    if (s.saving || s.busy) throw new ImportError(409, "This import is busy. Try again in a moment.");
    const { name } = checked;
    if (this.#taken(name)) throw new ImportError(409, `A sound named "${name}" already exists. Choose another name.`);

    s.saving = true;
    const finalPath = join(this.#o.soundsDir, `${name}${s.ext}`);
    const tmpPath = join(this.#o.soundsDir, `.import-${randomUUID()}.tmp`);
    try {
      try {
        if (!(await stat(this.#o.soundsDir)).isDirectory()) throw new Error("not a directory");
      } catch {
        this.#o.log?.(`Sounds folder missing or not a directory: ${this.#o.soundsDir}`);
        throw new ImportError(500, "The sounds folder is missing on the server. Check SOUNDS_DIR.");
      }
      try {
        await copyFile(s.outPath, tmpPath, constants.COPYFILE_EXCL);
        try {
          await link(tmpPath, finalPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EEXIST") throw new ImportError(409, `A sound named "${name}" already exists. Choose another name.`);
          if (!["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code ?? "")) throw err;
          if (await stat(finalPath).then(() => true, () => false))
            throw new ImportError(409, `A sound named "${name}" already exists. Choose another name.`);
          await rename(tmpPath, finalPath);
        }
      } catch (err) {
        if (err instanceof ImportError) throw err;
        this.#o.log?.(`Could not write ${finalPath}`, err);
        throw new ImportError(500, "Could not write to the sounds folder. Check its permissions and free space.");
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
      this.#o.library.invalidate();
      this.#staged.delete(id);
      this.#dispose(s);
      return { name, file: `${name}${s.ext}` };
    } finally {
      s.saving = false;
    }
  }

  discard(id: string): boolean {
    const s = STAGED_ID.test(id) ? this.#staged.get(id) : undefined;
    if (!s || s.saving || s.busy) return false;
    this.#staged.delete(id);
    this.#dispose(s);
    return true;
  }

  close(): void {
    clearInterval(this.#timer);
    for (const s of this.#staged.values()) this.#dispose(s);
    this.#staged.clear();
  }

  #trimLimits() {
    return { defaultSec: this.#o.defaultTrimSec, maxOutputSec: this.#o.maxOutputSec };
  }

  #get(id: string): Staged {
    const s = STAGED_ID.test(id) ? this.#staged.get(id) : undefined;
    if (!s) throw new ImportError(404, "That import expired or doesn't exist. Upload the file again.");
    return s;
  }

  #dispose(s: Staged): void {
    rmSync(s.srcPath, { force: true });
    rmSync(s.outPath, { force: true });
  }

  #taken(name: string): boolean {
    const l = lower(name);
    return this.#o.library.list().some((n) => lower(n) === l);
  }

  #sweep(now = Date.now()): void {
    const ttl = this.#o.ttlMs ?? 30 * 60_000;
    for (const [id, s] of this.#staged) {
      if (!s.saving && !s.busy && now - s.touchedAt > ttl) {
        this.#staged.delete(id);
        this.#dispose(s);
      }
    }
  }

  #tooLarge(): ImportError {
    const mb = this.#o.maxUploadBytes / 1024 / 1024;
    return new ImportError(413, `File is too large. The limit is ${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB.`);
  }

  async #checkDisk(declared: number | null): Promise<void> {
    const free = await (this.#o.freeSpace ?? defaultFreeSpace)(this.#o.stagingDir);
    const need = (declared ?? this.#o.maxUploadBytes) + this.#o.maxOutputBytes + 16 * 1024 * 1024;
    if (free !== null && free < need) {
      this.#o.log?.(`Import refused: ${free} bytes free, ${need} needed`);
      throw new ImportError(507, "The server doesn't have enough free disk space for this import.");
    }
  }

  async #receive(body: Readable, path: string): Promise<void> {
    let total = 0;
    const max = this.#o.maxUploadBytes;
    const limiter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        total += chunk.length;
        if (total > max) cb(this.#tooLarge());
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(body, limiter, createWriteStream(path, { flags: "wx" }));
    } catch (err) {
      if (err instanceof ImportError) throw err;
      this.#o.log?.("Upload failed", err);
      throw new ImportError(400, "The upload was interrupted. Try again.");
    }
    if (total === 0) throw new ImportError(400, "The file is empty.");
  }

  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new ImportError(429, "Another file is being processed. Try again in a few seconds.");
    this.#busy = true;
    try {
      return await fn();
    } finally {
      this.#busy = false;
    }
  }

  async #probe(path: string): Promise<Probe> {
    let stdout: string;
    try {
      ({ stdout } = await run(
        this.#o.ffprobePath,
        ["-v", "error", "-hide_banner", "-protocol_whitelist", "file", "-format_whitelist", this.#demuxers.join(","),
          "-print_format", "json", "-show_format", "-show_streams", path],
        PROBE_TIMEOUT_MS,
      ));
    } catch (err) {
      this.#o.log?.("ffprobe rejected a file", err);
      if ((err as { killed?: boolean }).killed) throw new ImportError(422, "Reading the file took too long, so it was rejected.");
      throw new ImportError(422, "This doesn't look like a valid audio or video file (or it is damaged, or in a format that isn't supported).");
    }
    let data: { format?: Record<string, string>; streams?: Array<Record<string, unknown>> };
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new ImportError(422, "The file's audio information could not be read.");
    }
    const num = (v: unknown): number | null => {
      const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const streams = data.streams ?? [];
    const audio = streams.filter((s) => s.codec_type === "audio");
    const hasVideo = streams.some(
      (s) => s.codec_type === "video" && !((s.disposition as Record<string, number> | undefined)?.attached_pic),
    );
    const usable = audio.find((s) => typeof s.codec_name === "string" && s.codec_name !== "none" && num(s.sample_rate) !== null);
    return {
      format: (data.format?.format_name ?? "").split(",")[0] ?? "",
      codec: typeof usable?.codec_name === "string" ? usable.codec_name : "",
      audioIndex: typeof usable?.index === "number" ? usable.index : null,
      durationSec: num(data.format?.duration) ?? num(usable?.duration),
      sampleRate: num(usable?.sample_rate),
      channels: num(usable?.channels),
      audioStreams: audio.length,
      hasVideo,
    };
  }

  #validateSource(p: Probe): void {
    if (p.audioStreams < 1)
      throw new ImportError(422, p.hasVideo ? "This video has no audio track, so there is nothing to import." : "No audio was found in this file.");
    if (p.audioIndex === null) throw new ImportError(422, "The audio track in this file can't be read (unknown codec).");
    if (p.durationSec !== null && p.durationSec < MIN_AUDIO_SEC) throw new ImportError(422, "The audio is empty or too short to play.");
  }

  #keepExtension(p: Probe): string | null {
    if (p.hasVideo || p.audioStreams !== 1 || p.durationSec === null || p.durationSec > this.#o.maxOutputSec + DURATION_EPSILON) return null;
    const accepted = this.#o.acceptedExtensions.map((e) => e.toLowerCase());
    if (p.format === "mp3" && accepted.includes(".mp3")) return ".mp3";
    if (p.format === "wav" && accepted.includes(".wav")) return ".wav";
    return null;
  }

  async #render(id: string, srcPath: string, probe: Probe, plan: TrimPlan, version: number) {
    const keep = plan.needsTrim ? null : this.#keepExtension(probe);
    const ext = keep ?? this.#outExt!;
    const outPath = join(this.#o.stagingDir, `${id}.out${version}${ext}`);
    const partPath = join(this.#o.stagingDir, `${id}.part`);
    try {
      if (keep) {
        try {
          await link(srcPath, outPath);
        } catch {
          await copyFile(srcPath, partPath);
          await rename(partPath, outPath);
        }
      } else {
        await this.#convert(srcPath, partPath, outPath, probe, plan, ext);
      }
      const after = keep ? probe : await this.#probe(outPath);
      const dur = after.durationSec;
      if (after.audioStreams < 1 || dur === null || dur < MIN_AUDIO_SEC)
        throw new ImportError(422, "The selected part contains no audio. The range may start after the audio ends.");
      if (dur > this.#o.maxOutputSec + 0.5)
        throw new ImportError(422, `The result is longer than ${this.#o.maxOutputSec} s, the limit for a saved sound. Choose a shorter range.`);
      const size = (await stat(outPath)).size;
      if (size > this.#o.maxOutputBytes)
        throw new ImportError(422, `The result is ${(size / 1024 / 1024).toFixed(0)} MB, over the ${(this.#o.maxOutputBytes / 1024 / 1024).toFixed(0)} MB limit. Choose a shorter range.`);
      const result: RenderResult = {
        version,
        mode: plan.mode,
        startSec: plan.startSec,
        endSec: plan.startSec + dur,
        durationSec: dur,
        extension: ext,
        sizeBytes: size,
        sampleRate: after.sampleRate,
        channels: after.channels,
        converted: !keep,
        note: keep
          ? `Already ${ext.slice(1).toUpperCase()}, so it was kept exactly as uploaded.`
          : `Converted to ${ext.slice(1).toUpperCase()} (48 kHz stereo), the format the soundboard plays.`,
      };
      return { path: outPath, result };
    } catch (err) {
      await rm(outPath, { force: true });
      await rm(partPath, { force: true });
      throw err;
    }
  }

  async #convert(srcPath: string, partPath: string, outPath: string, probe: Probe, plan: TrimPlan, ext: string): Promise<void> {
    const limit = plan.lengthSec ?? this.#o.maxOutputSec + 1;
    const bytesPerSec = ext === ".mp3" ? 40_000 : 192_000;
    if (limit * bytesPerSec > this.#o.maxOutputBytes)
      throw new ImportError(422, `That selection would be too large as ${ext.slice(1).toUpperCase()}. Choose a shorter range.`);
    const codec = ext === ".mp3" ? ["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"] : ["-c:a", "pcm_s16le", "-f", "wav"];
    const timeout = Math.ceil(Math.min(this.#o.processTimeoutMs, Math.max(30_000, 20_000 + limit * 500)));
    try {
      await run(
        this.#o.ffmpegPath,
        ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
          "-protocol_whitelist", "file", "-format_whitelist", this.#demuxers.join(","), "-threads", "1",
          ...(plan.startSec > 0 ? ["-ss", fmtSec(plan.startSec)] : []),
          "-i", srcPath,
          "-map", `0:${probe.audioIndex}`, "-vn", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
          "-t", fmtSec(limit),
          "-ar", "48000", "-ac", "2", ...codec, partPath],
        timeout,
      );
    } catch (err) {
      this.#o.log?.("ffmpeg conversion failed", err);
      if ((err as { killed?: boolean }).killed) throw new ImportError(422, "Processing took too long, so it was stopped. Try a shorter selection.");
      throw new ImportError(422, "FFmpeg could not process this file. It may be damaged or use an unsupported codec.");
    }
    await rename(partPath, outPath);
  }
}