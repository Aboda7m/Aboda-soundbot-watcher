import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { extname } from "node:path";
import type { StreamHandle, StreamProvider, StreamProviderInfo, StreamStartOptions, VideoPublisher } from "./StreamProvider.ts";
import { StreamProviderUnavailableError } from "./StreamProvider.ts";

interface ProbeResult {
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; sample_rate?: string; r_frame_rate?: string; bit_rate?: string }>;
  format?: { duration?: string; format_name?: string };
}

function parseFrameRate(value: string | undefined): number | null {
  const [num, den] = (value ?? "").split("/").map(Number);
  if (!num || !Number.isFinite(num)) return null;
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 && fps <= 240 ? Math.round(fps * 100) / 100 : null;
}

/** Why publishing is unavailable. Verified against Discord's developer docs (voice connections):
 * bots may send Opus audio only; video (voice gateway opcode 12) and Go Live streams are
 * undocumented, user-client features. The only library that implements them
 * (@dank074/discord-video-stream) documents that Discord blocks video from bot tokens and
 * requires a user-account token, i.e. a selfbot, which this project must not use. */
export const VIDEO_PUBLISHING_UNAVAILABLE_REASON =
  "Discord does not let regular bot accounts publish video to a voice channel. The official voice API only supports " +
  "Opus audio from bots, and Go Live/camera video is only available to user accounts (selfbots). To opt in to a user-account publisher anyway, see the \"Video streaming\" section of the README.";

/** Validates/probes local MP4 files. It never fakes publishing: until Discord offers a bot-legal video
 * transport, start() inspects the file and then fails with an explicit error.
 * This provider never touches VoiceHub/audio playback. */
export class Mp4StreamProvider implements StreamProvider {
  private readonly options: { directory: string; ffprobePath: string; publisher?: VideoPublisher; publisherProblem?: string };

  /** `publisher` is the opt-in transport that really sends video. Without one, start() inspects the file
   * and then fails with an explicit error; `publisherProblem` says why none is configured. */
  constructor(options: { directory: string; ffprobePath: string; publisher?: VideoPublisher; publisherProblem?: string }) {
    this.options = options;
  }

  info(): StreamProviderInfo {
    if (this.options.publisher) {
      return {
        provider: "mp4",
        available: true,
        reason: `Publishing through "${this.options.publisher.name}". This uses a user account instead of a bot account, which Discord's Terms of Service do not allow.`,
      };
    }
    return {
      provider: "mp4",
      available: false,
      reason: this.options.publisherProblem ?? VIDEO_PUBLISHING_UNAVAILABLE_REASON,
    };
  }

  async inspect(filePath: string): Promise<{ durationSec: number | null; videoCodec: string | null; audioCodec: string | null; width: number | null; height: number | null; fps: number | null; bitrateKbps: number | null }> {
    await access(filePath, constants.R_OK);
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("The selected stream path is not a file.");
    if (extname(filePath).toLowerCase() !== ".mp4") throw new Error("Only .mp4 files are supported.");

    const result = await new Promise<ProbeResult>((resolve, reject) => {
      const child = spawn(this.options.ffprobePath, [
        "-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,sample_rate,r_frame_rate,bit_rate",
        "-of", "json", filePath,
      ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) reject(new Error(`ffprobe failed (${code}): ${stderr.trim() || "unknown error"}`));
        else {
          try { resolve(JSON.parse(stdout) as ProbeResult); }
          catch { reject(new Error("ffprobe returned invalid JSON.")); }
        }
      });
    });

    const video = result.streams?.find((stream) => stream.codec_type === "video");
    const audio = result.streams?.find((stream) => stream.codec_type === "audio");
    if (!video) throw new Error("The MP4 does not contain a video stream.");
    return {
      durationSec: Number.isFinite(Number(result.format?.duration)) ? Number(result.format?.duration) : null,
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      width: video.width ?? null,
      height: video.height ?? null,
      fps: parseFrameRate(video.r_frame_rate),
      bitrateKbps: Number.isFinite(Number(video.bit_rate)) && Number(video.bit_rate) > 0 ? Math.round(Number(video.bit_rate) / 1000) : null,
    };
  }

  async start(options: StreamStartOptions): Promise<StreamHandle> {
    const metadata = await this.inspect(options.filePath);
    const details = `${metadata.width ?? "?"}x${metadata.height ?? "?"}, ${metadata.videoCodec ?? "unknown"} video${metadata.audioCodec ? `, ${metadata.audioCodec} audio` : ", no audio"}`;
    if (!this.options.publisher) {
      throw new StreamProviderUnavailableError(`The MP4 is valid (${details}), but it cannot be streamed: ${this.info().reason}`);
    }
    return this.options.publisher.publish({ ...options, media: { width: metadata.width, height: metadata.height, fps: metadata.fps, bitrateKbps: metadata.bitrateKbps } });
  }
}
