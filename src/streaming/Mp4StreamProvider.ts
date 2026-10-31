import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { extname } from "node:path";
import type { StreamHandle, StreamProvider, StreamProviderInfo, StreamStartOptions } from "./StreamProvider.ts";
import { StreamProviderUnavailableError } from "./StreamProvider.ts";

interface ProbeResult {
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; sample_rate?: string }>;
  format?: { duration?: string; format_name?: string };
}

/** Validates/probes local MP4 files. Publishing is deliberately disabled until a bot-compatible
 * Discord Go Live video transport is implemented. This provider never touches VoiceHub/audio playback. */
export class Mp4StreamProvider implements StreamProvider {
  private readonly options: { directory: string; ffprobePath: string };

  constructor(options: { directory: string; ffprobePath: string }) {
    this.options = options;
  }

  info(): StreamProviderInfo {
    return {
      provider: "mp4",
      available: false,
      reason: "MP4 inspection is available, but Discord bot video publishing has no supported transport configured.",
    };
  }

  async inspect(filePath: string): Promise<{ durationSec: number | null; videoCodec: string | null; audioCodec: string | null; width: number | null; height: number | null }> {
    await access(filePath, constants.R_OK);
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("The selected stream path is not a file.");
    if (extname(filePath).toLowerCase() !== ".mp4") throw new Error("Only .mp4 files are supported.");

    const result = await new Promise<ProbeResult>((resolve, reject) => {
      const child = spawn(this.options.ffprobePath, [
        "-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,sample_rate",
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
    };
  }

  async start(options: StreamStartOptions): Promise<StreamHandle> {
    const metadata = await this.inspect(options.filePath);
    const details = `${metadata.width ?? "?"}x${metadata.height ?? "?"}, ${metadata.videoCodec ?? "unknown"} video${metadata.audioCodec ? `, ${metadata.audioCodec} audio` : ", no audio"}`;
    throw new StreamProviderUnavailableError(`The MP4 is valid (${details}), but ${this.info().reason}`);
  }
}
