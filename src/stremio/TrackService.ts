import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, existsSync, renameSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Subtitle / audio-track support for the Stremio player.
 *
 * Why this exists: a browser <video> can play an MKV, but it does not expose the subtitle tracks inside it, and it cannot
 * switch between its audio tracks (Chrome ships audioTracks disabled). So the bot opens the same source with FFmpeg,
 *   - lists the tracks (ffprobe),
 *   - converts text subtitles (ASS/SSA/SRT/mov_text/WebVTT) to WebVTT in one pass over the file,
 *   - converts a chosen alternative audio track to AAC on demand.
 * The viewer's page then attaches the .vtt files as <track> elements and plays the alternative audio in a hidden <audio>
 * element kept in sync with the video. The video itself is never transcoded here.
 *
 * FFmpeg only ever reads inputs the bot built itself (the local streaming server or an https stream URL it was given by an addon),
 * never anything the browser sends, and is restricted to http(s) protocols.
 */

export interface AudioTrack { id: number; label: string; lang: string; default: boolean; url: string }
export interface SubTrack { id: number; label: string; lang: string; default: boolean; forced: boolean; supported: boolean; url?: string }
export interface PublicTracks { audio: AudioTrack[]; subs: SubTrack[] }

interface RawTrack { id: number; streamIndex: number; lang: string; title: string; codec: string; channels: number; def: boolean; forced: boolean }
interface Entry {
  input: string; created: number; dir: string;
  audio: RawTrack[]; subs: RawTrack[];
  probed?: Promise<PublicTracks>;
  subJob?: Promise<void>; subFiles: Map<number, string>;
  audioJobs: Map<number, Promise<void>>; audioFiles: Map<number, string>; audioFailed: Map<number, string>;
}

export interface TrackServiceOptions {
  ffmpegPath: string; ffprobePath: string;
  /** Where cached subtitles/audio live. Default: <tmp>/aboda-stremio-tracks (wiped at startup). */
  dir?: string;
  ttlMs?: number; probeTimeoutMs?: number; jobTimeoutMs?: number; maxConcurrentJobs?: number;
  log?: (msg: string) => void;
}

const TEXT_SUBS = new Set(["ass", "ssa", "subrip", "srt", "mov_text", "webvtt", "text"]);
const PROTOCOLS = "http,https,tcp,tls,crypto";
const B_TO_T: Record<string, string> = { ger: "deu", fre: "fra", chi: "zho", dut: "nld", gre: "ell", cze: "ces", rum: "ron", slo: "slk", per: "fas", may: "msa", ice: "isl", baq: "eus", wel: "cym", alb: "sqi", arm: "hye", geo: "kat", mac: "mkd", mao: "mri", bur: "mya", tib: "bod" };
const CODEC_NAMES: Record<string, string> = { ass: "ASS", ssa: "SSA", subrip: "SRT", srt: "SRT", mov_text: "Text", webvtt: "WebVTT", hdmv_pgs_subtitle: "PGS image", dvd_subtitle: "VobSub image", dvb_subtitle: "DVB image", aac: "AAC", ac3: "AC3", eac3: "E-AC3", dts: "DTS", opus: "Opus", flac: "FLAC", vorbis: "Vorbis", mp3: "MP3", truehd: "TrueHD" };

export function languageName(code: string): string {
  const c = (code || "").toLowerCase();
  if (!c || c === "und" || c === "mis" || c === "mul") return "Unknown";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(B_TO_T[c] ?? c);
    if (name && name.toLowerCase() !== c) return name;
  } catch { /* not a valid language tag */ }
  return c.toUpperCase();
}
const channelsLabel = (n: number) => (n === 1 ? "mono" : n === 2 ? "2.0" : n === 6 ? "5.1" : n === 8 ? "7.1" : n ? `${n}ch` : "");

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = "";
    p.stdout.on("data", (d: Buffer) => { if (stdout.length < 4_000_000) stdout += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { if (stderr.length < 4000) stderr += d.toString(); });
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

export class TrackService {
  #o: Required<Omit<TrackServiceOptions, "log">> & { log?: (m: string) => void };
  #entries = new Map<string, Entry>();
  #running = 0;
  #queue: (() => void)[] = [];

  constructor(opts: TrackServiceOptions) {
    this.#o = { dir: join(tmpdir(), "aboda-stremio-tracks"), ttlMs: 12 * 3_600_000, probeTimeoutMs: 45_000, jobTimeoutMs: 30 * 60_000, maxConcurrentJobs: 2, ...opts };
    try { rmSync(this.#o.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    mkdirSync(this.#o.dir, { recursive: true });
  }

  /** Remember a source FFmpeg may read. `input` must be built by the bot, never taken from a request. */
  register(input: string): string {
    this.#sweep();
    if (this.#entries.size >= 30) { const oldest = this.#entries.keys().next().value; if (oldest) this.#drop(oldest); }
    const id = randomBytes(16).toString("hex");
    const dir = join(this.#o.dir, id); mkdirSync(dir, { recursive: true });
    this.#entries.set(id, { input, created: Date.now(), dir, audio: [], subs: [], subFiles: new Map(), audioJobs: new Map(), audioFiles: new Map(), audioFailed: new Map() });
    return id;
  }

  #drop(id: string) {
    const e = this.#entries.get(id); if (!e) return;
    this.#entries.delete(id);
    try { rmSync(e.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  #sweep() { const now = Date.now(); for (const [id, e] of this.#entries) if (now - e.created > this.#o.ttlMs) this.#drop(id); }
  close() { for (const id of [...this.#entries.keys()]) this.#drop(id); try { rmSync(this.#o.dir, { recursive: true, force: true }); } catch { /* ignore */ } }

  async #slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#o.maxConcurrentJobs) await new Promise<void>((r) => this.#queue.push(r));
    this.#running++;
    try { return await fn(); } finally { this.#running--; this.#queue.shift()?.(); }
  }

  #inputArgs(input: string): string[] {
    return ["-protocol_whitelist", PROTOCOLS, ...(input.startsWith("http") ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"] : []), "-i", input];
  }

  /** List the tracks (once per source) and start converting the text subtitles in the background. */
  probe(id: string): Promise<PublicTracks> {
    const e = this.#entries.get(id);
    if (!e) return Promise.reject(new Error("unknown source"));
    e.probed ??= this.#probe(id, e).catch((err) => { e.probed = undefined; throw err; });
    return e.probed;
  }

  async #probe(id: string, e: Entry): Promise<PublicTracks> {
    const r = await run(this.#o.ffprobePath, ["-v", "error", "-protocol_whitelist", PROTOCOLS, "-print_format", "json", "-show_streams", e.input], this.#o.probeTimeoutMs);
    if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr.trim().split("\n").pop() ?? r.code}`);
    const streams = (JSON.parse(r.stdout).streams ?? []) as Record<string, unknown>[];
    let a = 0; let s = 0;
    for (const st of streams) {
      const tags = (st.tags ?? {}) as Record<string, string>; const disp = (st.disposition ?? {}) as Record<string, number>;
      const base = { streamIndex: Number(st.index), lang: String(tags.language ?? tags.LANGUAGE ?? "und"), title: String(tags.title ?? tags.TITLE ?? ""), codec: String(st.codec_name ?? ""), channels: Number(st.channels ?? 0), def: disp.default === 1, forced: disp.forced === 1 };
      if (st.codec_type === "audio") e.audio.push({ id: a++, ...base });
      else if (st.codec_type === "subtitle") e.subs.push({ id: s++, ...base });
    }
    const pub: PublicTracks = {
      audio: e.audio.map((t) => ({
        id: t.id, lang: t.lang, default: t.def || (t.id === 0 && !e.audio.some((x) => x.def)),
        label: [languageName(t.lang), t.title && t.title.toLowerCase() !== languageName(t.lang).toLowerCase() ? `— ${t.title}` : "", `(${[CODEC_NAMES[t.codec] ?? t.codec.toUpperCase(), channelsLabel(t.channels)].filter(Boolean).join(" ")})`].filter(Boolean).join(" "),
        url: `/api/stremio/t/${id}/audio-${t.id}.m4a`,
      })),
      subs: e.subs.map((t) => {
        const supported = TEXT_SUBS.has(t.codec);
        return {
          id: t.id, lang: t.lang, default: t.def, forced: t.forced, supported,
          label: [languageName(t.lang), t.title && t.title.toLowerCase() !== languageName(t.lang).toLowerCase() ? `— ${t.title}` : "", t.forced ? "[forced]" : "", `(${CODEC_NAMES[t.codec] ?? t.codec.toUpperCase()})`].filter(Boolean).join(" ").slice(0, 120),
          ...(supported ? { url: `/api/stremio/t/${id}/sub-${t.id}.vtt` } : {}),
        };
      }),
    };
    if (e.subs.some((t) => TEXT_SUBS.has(t.codec))) this.#startSubs(e);
    return pub;
  }

  #startSubs(e: Entry) {
    e.subJob ??= this.#slot(async () => {
      const wanted = e.subs.filter((t) => TEXT_SUBS.has(t.codec));
      const outFor = (t: RawTrack) => join(e.dir, `sub-${t.id}.vtt`);
      const convert = async (tracks: RawTrack[]) => {
        const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...this.#inputArgs(e.input)];
        for (const t of tracks) args.push("-map", `0:${t.streamIndex}`, "-c:s", "webvtt", "-f", "webvtt", `${outFor(t)}.part`);
        const r = await run(this.#o.ffmpegPath, args, this.#o.jobTimeoutMs);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `ffmpeg exit ${r.code}`);
        for (const t of tracks) { renameSync(`${outFor(t)}.part`, outFor(t)); e.subFiles.set(t.id, outFor(t)); }
      };
      try { await convert(wanted); }
      catch (err) {
        this.#o.log?.(`Subtitle extraction (all tracks) failed, retrying one by one: ${(err as Error).message}`);
        for (const t of wanted) { try { await convert([t]); } catch (e2) { this.#o.log?.(`Subtitle track ${t.id} failed: ${(e2 as Error).message}`); } }
      }
    }).catch((err) => this.#o.log?.(`Subtitle job failed: ${(err as Error).message}`));
  }

  /** Path of the finished WebVTT file; waits for the one-pass extraction. null = that track is not available. */
  async subtitleFile(id: string, n: number): Promise<string | null> {
    const e = this.#entries.get(id); if (!e) return null;
    await this.probe(id).catch(() => undefined);
    if (!e.subs.some((t) => t.id === n && TEXT_SUBS.has(t.codec))) return null;
    this.#startSubs(e); await e.subJob;
    return e.subFiles.get(n) ?? null;
  }

  /** Alternative audio: converted to AAC the first time someone asks, then served from disk. */
  audioStatus(id: string, n: number): { status: "ready"; path: string } | { status: "preparing" } | { status: "failed"; error: string } | { status: "missing" } {
    const e = this.#entries.get(id); if (!e) return { status: "missing" };
    const done = e.audioFiles.get(n); if (done) return { status: "ready", path: done };
    const failed = e.audioFailed.get(n); if (failed) return { status: "failed", error: failed };
    const t = e.audio.find((x) => x.id === n);
    if (!t) return { status: "missing" };
    if (!e.audioJobs.has(n)) {
      const out = join(e.dir, `audio-${n}.m4a`);
      e.audioJobs.set(n, this.#slot(async () => {
        const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...this.#inputArgs(e.input), "-map", `0:${t.streamIndex}`, "-vn", "-sn", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", `${out}.part`];
        const r = await run(this.#o.ffmpegPath, args, this.#o.jobTimeoutMs);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `ffmpeg exit ${r.code}`);
        renameSync(`${out}.part`, out); e.audioFiles.set(n, out);
      }).catch((err: Error) => { this.#o.log?.(`Audio track ${n} failed: ${err.message}`); e.audioFailed.set(n, "Could not extract this audio track."); }));
    }
    return { status: "preparing" };
  }

  /** For tests / diagnostics. */
  get cacheDir() { return this.#o.dir; }
  usedBytes(): number {
    let total = 0;
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); s.isDirectory() ? walk(p) : (total += s.size); } };
    if (existsSync(this.#o.dir)) walk(this.#o.dir);
    return total;
  }
}
