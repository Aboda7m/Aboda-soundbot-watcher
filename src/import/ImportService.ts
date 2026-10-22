import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream, readdirSync, rmSync, mkdirSync } from "node:fs";
import { copyFile, link, rename, rm, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import { checkName, cleanUploadName, suggestName } from "./names.ts";

/** Upload extensions accepted in Phase 1. Real validation is the ffprobe check, this only filters obvious mistakes. */
export const UPLOAD_EXTENSIONS = [".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".flac"];
/** Demuxers ffprobe/ffmpeg may use. Stops content-sniffing into playlist/concat/network formats. */
const DEMUXERS = "mp3,wav,ogg,flac,mov,aac";
const PROBE_TIMEOUT_MS = 10_000;
const CONVERT_TIMEOUT_MS = 30_000;
const STAGED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGED_FILE = /^[0-9a-f-]{36}\.(upload|out\.\w+)$/;

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
  maxDurationSec: number;
  ffmpegPath: string;
  ffprobePath: string;
  /** staged files are deleted after this long (default 30 min) */
  ttlMs?: number;
  /** staged + uploading files at once (default 8) */
  maxStaged?: number;
  log?(message: string, err?: unknown): void;
}

interface Probe {
  format: string;
  codec: string;
  durationSec: number | null;
  sampleRate: number | null;
  channels: number | null;
  audioStreams: number;
  hasVideo: boolean;
}

interface Staged {
  id: string;
  path: string; // processed result, the file that gets saved
  ext: string;
  mime: string;
  sizeBytes: number;
  createdAt: number;
  saving: boolean;
}

export interface StagedInfo {
  id: string;
  suggestedName: string;
  nameTaken: boolean;
  original: { fileName: string; sizeBytes: number; format: string; codec: string };
  result: {
    extension: string;
    sizeBytes: number;
    durationSec: number;
    sampleRate: number | null;
    channels: number | null;
    converted: boolean;
    note: string;
  };
}

const MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav" };
const lower = (s: string) => s.normalize("NFC").toLowerCase();

function run(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })),
    );
  });
}

/**
 * Phase 1 import pipeline: stage (upload + validate + convert if needed) -> preview -> save.
 * Staged files live in a private temp folder under random ids; the client never supplies a path.
 * Only one ffprobe/ffmpeg job runs at a time, and every job has a timeout and a duration cap.
 */
export class ImportService {
  #o: ImportOptions;
  #staged = new Map<string, Staged>();
  #uploading = 0;
  #busy = false;
  #toolsOk = false;
  #timer: NodeJS.Timeout;
  #outExt: string | null;

  constructor(opts: ImportOptions) {
    this.#o = opts;
    const accepted = opts.acceptedExtensions.map((e) => e.toLowerCase());
    this.#outExt = accepted.includes(".mp3") ? ".mp3" : accepted.includes(".wav") ? ".wav" : null;
    mkdirSync(opts.stagingDir, { recursive: true });
    // Remove leftovers of a previous run. Only files that match our own naming are touched.
    for (const f of readdirSync(opts.stagingDir)) {
      if (STAGED_FILE.test(f)) rmSync(join(opts.stagingDir, f), { force: true });
    }
    this.#timer = setInterval(() => this.#sweep(), 60_000);
    this.#timer.unref();
  }

  limits() {
    return {
      maxUploadBytes: this.#o.maxUploadBytes,
      maxDurationSec: this.#o.maxDurationSec,
      extensions: UPLOAD_EXTENSIONS,
      outputExtension: this.#outExt,
    };
  }

  /** Is the feature usable right now? Re-checked each call until it succeeds, so installing ffmpeg needs no restart. */
  async status(): Promise<{ ready: boolean; problem?: string }> {
    if (!this.#outExt) return { ready: false, problem: "ACCEPTED_EXTENSIONS must include .mp3 or .wav for imports to work." };
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
    this.#toolsOk = true;
  }

  /** Receive an upload, validate it and prepare the version that would be saved. */
  async stage(body: Readable, rawFileName: string, declaredLength: number | null): Promise<StagedInfo> {
    this.#sweep();
    const fileName = cleanUploadName(rawFileName);
    const ext = extname(fileName).toLowerCase();
    if (!UPLOAD_EXTENSIONS.includes(ext))
      throw new ImportError(415, `Unsupported file type${ext ? ` "${ext}"` : ""}. Supported: ${UPLOAD_EXTENSIONS.join(", ")}.`);
    if (declaredLength !== null && declaredLength <= 0) throw new ImportError(400, "The file is empty.");
    if (declaredLength !== null && declaredLength > this.#o.maxUploadBytes) throw this.#tooLarge();
    if (!this.#outExt) throw new ImportError(503, "ACCEPTED_EXTENSIONS must include .mp3 or .wav for imports to work.");
    if (this.#staged.size + this.#uploading >= (this.#o.maxStaged ?? 8))
      throw new ImportError(429, "Too many pending imports. Save or discard one first.");
    await this.#ensureTools();

    const id = randomUUID();
    const inPath = join(this.#o.stagingDir, `${id}.upload`);
    let outPath: string | null = null;
    this.#uploading++;
    try {
      await this.#receive(body, inPath);
      const info = await this.#exclusive(async () => {
        const probe = await this.#probe(inPath);
        this.#validate(probe);
        const keep = this.#keepExtension(probe);
        const finalExt = keep ?? this.#outExt!;
        outPath = join(this.#o.stagingDir, `${id}.out${finalExt}`);
        let note: string;
        if (keep) {
          await rename(inPath, outPath);
          note = `Already ${keep.slice(1).toUpperCase()}, so it was kept exactly as uploaded.`;
        } else {
          await this.#convert(inPath, outPath, finalExt);
          note = `Converted from ${probe.codec.toUpperCase() || probe.format.toUpperCase()} to ${finalExt.slice(1).toUpperCase()} (48 kHz stereo) so the soundboard can play it.`;
        }
        const after = keep ? probe : await this.#probe(outPath);
        this.#validate(after);
        const size = (await stat(outPath)).size;
        return { probe, after, keep, finalExt, size, note, outPath };
      });
      const sizeIn = declaredLength ?? info.size;
      this.#staged.set(id, {
        id, path: info.outPath, ext: info.finalExt, mime: MIME[info.finalExt] ?? "application/octet-stream",
        sizeBytes: info.size, createdAt: Date.now(), saving: false,
      });
      const suggested = suggestName(fileName);
      return {
        id,
        suggestedName: suggested,
        nameTaken: suggested !== "" && this.#taken(suggested),
        original: { fileName, sizeBytes: sizeIn, format: info.probe.format, codec: info.probe.codec },
        result: {
          extension: info.finalExt,
          sizeBytes: info.size,
          durationSec: info.after.durationSec ?? 0,
          sampleRate: info.after.sampleRate,
          channels: info.after.channels,
          converted: !info.keep,
          note: info.note,
        },
      };
    } catch (err) {
      await rm(inPath, { force: true });
      if (outPath) await rm(outPath, { force: true });
      throw err;
    } finally {
      this.#uploading--;
    }
  }

  /** Path + type of a staged result for the preview player, or null. */
  preview(id: string): { path: string; mime: string; sizeBytes: number } | null {
    const s = STAGED_ID.test(id) ? this.#staged.get(id) : undefined;
    return s ? { path: s.path, mime: s.mime, sizeBytes: s.sizeBytes } : null;
  }

  /** Move a staged result into the sounds folder under a validated name. Never overwrites. */
  async save(id: string, rawName: unknown): Promise<{ name: string; file: string }> {
    const s = STAGED_ID.test(id) ? this.#staged.get(id) : undefined;
    if (!s) throw new ImportError(404, "That import expired or doesn't exist. Upload the file again.");
    const checked = checkName(rawName);
    if (!checked.ok) throw new ImportError(400, checked.error);
    if (s.saving) throw new ImportError(409, "This import is already being saved.");
    const { name } = checked;
    if (this.#taken(name)) throw new ImportError(409, `A sound named "${name}" already exists. Choose another name.`);

    s.saving = true;
    const finalPath = join(this.#o.soundsDir, `${name}${s.ext}`);
    const tmpPath = join(this.#o.soundsDir, `.import-${randomUUID()}.tmp`); // hidden + unknown extension: the library ignores it
    try {
      try {
        if (!(await stat(this.#o.soundsDir)).isDirectory()) throw new Error("not a directory");
      } catch {
        this.#o.log?.(`Sounds folder missing or not a directory: ${this.#o.soundsDir}`);
        throw new ImportError(500, "The sounds folder is missing on the server. Check SOUNDS_DIR.");
      }
      try {
        await copyFile(s.path, tmpPath, constants.COPYFILE_EXCL);
        try {
          await link(tmpPath, finalPath); // atomic and refuses to replace an existing file
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EEXIST") throw new ImportError(409, `A sound named "${name}" already exists. Choose another name.`);
          if (!["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code ?? "")) throw err;
          // Filesystem without hard links (FAT/exFAT, some network shares): fall back to rename after an existence check.
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
      this.#o.library.invalidate(); // new file is visible immediately, even on filesystems with coarse timestamps
      this.#staged.delete(id);
      await rm(s.path, { force: true });
      return { name, file: `${name}${s.ext}` };
    } finally {
      s.saving = false;
    }
  }

  discard(id: string): boolean {
    const s = STAGED_ID.test(id) ? this.#staged.get(id) : undefined;
    if (!s || s.saving) return false;
    this.#staged.delete(id);
    rmSync(s.path, { force: true });
    return true;
  }

  close(): void {
    clearInterval(this.#timer);
    for (const s of this.#staged.values()) rmSync(s.path, { force: true });
    this.#staged.clear();
  }

  // ---------------------------------------------------------------------------------------------

  #taken(name: string): boolean {
    const l = lower(name);
    return this.#o.library.list().some((n) => lower(n) === l);
  }

  #sweep(now = Date.now()): void {
    const ttl = this.#o.ttlMs ?? 30 * 60_000;
    for (const [id, s] of this.#staged) {
      if (!s.saving && now - s.createdAt > ttl) {
        this.#staged.delete(id);
        rmSync(s.path, { force: true });
      }
    }
  }

  #tooLarge(): ImportError {
    return new ImportError(413, `File is too large. The limit is ${(this.#o.maxUploadBytes / 1024 / 1024).toFixed(0)} MB.`);
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
        ["-v", "error", "-hide_banner", "-protocol_whitelist", "file", "-format_whitelist", DEMUXERS,
          "-print_format", "json", "-show_format", "-show_streams", path],
        PROBE_TIMEOUT_MS,
      ));
    } catch (err) {
      this.#o.log?.("ffprobe rejected a file", err);
      if ((err as { killed?: boolean }).killed) throw new ImportError(422, "Reading the file took too long, so it was rejected.");
      throw new ImportError(422, "This doesn't look like a valid audio file (it couldn't be read as MP3, WAV, OGG, Opus, M4A, AAC or FLAC).");
    }
    let data: { format?: Record<string, string>; streams?: Array<Record<string, unknown>> };
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new ImportError(422, "The file's audio information could not be read.");
    }
    const streams = data.streams ?? [];
    const audio = streams.filter((s) => s.codec_type === "audio");
    const hasVideo = streams.some(
      (s) => s.codec_type === "video" && !((s.disposition as Record<string, number> | undefined)?.attached_pic),
    );
    const a = audio[0] ?? {};
    const num = (v: unknown): number | null => {
      const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    return {
      format: (data.format?.format_name ?? "").split(",")[0] ?? "",
      codec: typeof a.codec_name === "string" ? a.codec_name : "",
      durationSec: num(data.format?.duration) ?? num(a.duration),
      sampleRate: num(a.sample_rate),
      channels: num(a.channels),
      audioStreams: audio.length,
      hasVideo,
    };
  }

  #validate(p: Probe): void {
    if (p.audioStreams < 1) throw new ImportError(422, "No audio was found in this file.");
    if (p.hasVideo) throw new ImportError(422, "This file contains video. Importing audio from video files isn't supported yet.");
    if (p.durationSec !== null) {
      if (p.durationSec < 0.05) throw new ImportError(422, "The audio is empty or too short to play.");
      if (p.durationSec > this.#o.maxDurationSec)
        throw new ImportError(422, `The audio is ${p.durationSec.toFixed(1)} s long. The limit is ${this.#o.maxDurationSec} s.`);
    }
  }

  /** Keep the upload untouched only when it is really MP3 or WAV (by content), that format is accepted, and the length is known. */
  #keepExtension(p: Probe): string | null {
    if (p.durationSec === null) return null;
    const accepted = this.#o.acceptedExtensions.map((e) => e.toLowerCase());
    if (p.format === "mp3" && accepted.includes(".mp3")) return ".mp3";
    if (p.format === "wav" && accepted.includes(".wav")) return ".wav";
    return null;
  }

  async #convert(inPath: string, outPath: string, ext: string): Promise<void> {
    const codec = ext === ".mp3" ? ["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"] : ["-c:a", "pcm_s16le", "-f", "wav"];
    try {
      await run(
        this.#o.ffmpegPath,
        ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
          "-protocol_whitelist", "file", "-format_whitelist", DEMUXERS, "-i", inPath,
          "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1",
          "-t", String(this.#o.maxDurationSec + 1), // hard stop even if the header lied about the length
          "-ar", "48000", "-ac", "2", ...codec, outPath],
        CONVERT_TIMEOUT_MS,
      );
    } catch (err) {
      this.#o.log?.("ffmpeg conversion failed", err);
      if ((err as { killed?: boolean }).killed) throw new ImportError(422, "Converting the file took too long, so it was stopped.");
      throw new ImportError(422, "FFmpeg could not convert this file. It may be damaged or use an unsupported codec.");
    }
  }
}
