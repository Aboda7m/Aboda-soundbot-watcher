import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface VideoStreamConfig {
  /** "disabled" (default): no video is published. "selfbot": publish through a user-account session (see README). */
  publisher: "disabled" | "selfbot";
  /** Must be true for publisher "selfbot": the person running the bot accepts that this breaks Discord's ToS. */
  selfbotAcknowledgeTosRisk: boolean;
  streamsDirectory: string;
  respectVideoParams: boolean;
  bitrateOverride: boolean;
  width: number;
  height: number;
  maxWidth: number;
  maxHeight: number;
  fps: number;
  bitrateKbps: number;
  maxBitrateKbps: number;
  hardwareAcceleration: boolean;
  videoCodec: "H264" | "H265" | "VP8" | "VP9" | "AV1";
  h26xPreset: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = resolve(PROJECT_ROOT, "videostream.json");
const EXAMPLE_PATH = resolve(PROJECT_ROOT, "videostream.example.json");

function requireNumber(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`videostream.json: "${key}" must be a number between ${min} and ${max}.`);
  }
  return value;
}

function requireBoolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") throw new Error(`videostream.json: "${key}" must be true or false.`);
  return value;
}

export async function loadVideoStreamConfig(): Promise<VideoStreamConfig> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  try {
    await readFile(CONFIG_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await copyFile(EXAMPLE_PATH, CONFIG_PATH);
    console.info(`[stream] Created ${CONFIG_PATH} from videostream.example.json.`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Could not parse videostream.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const codecs = ["H264", "H265", "VP8", "VP9", "AV1"] as const;
  const presets = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"] as const;
  if (typeof raw.streamsDirectory !== "string" || !raw.streamsDirectory.trim()) {
    throw new Error('videostream.json: "streamsDirectory" must be a non-empty path.');
  }
  if (typeof raw.videoCodec !== "string" || !codecs.includes(raw.videoCodec as typeof codecs[number])) {
    throw new Error(`videostream.json: "videoCodec" must be one of ${codecs.join(", ")}.`);
  }
  if (typeof raw.h26xPreset !== "string" || !presets.includes(raw.h26xPreset as typeof presets[number])) {
    throw new Error(`videostream.json: "h26xPreset" must be one of ${presets.join(", ")}.`);
  }

  // Optional keys: absent in files written before they existed, so they default instead of failing the load.
  const publisher = raw.publisher ?? "disabled";
  if (publisher !== "disabled" && publisher !== "selfbot") {
    throw new Error('videostream.json: "publisher" must be "disabled" or "selfbot".');
  }
  const selfbotAcknowledgeTosRisk = raw.selfbotAcknowledgeTosRisk === undefined ? false : requireBoolean(raw.selfbotAcknowledgeTosRisk, "selfbotAcknowledgeTosRisk");

  return {
    publisher,
    selfbotAcknowledgeTosRisk,
    streamsDirectory: resolve(PROJECT_ROOT, raw.streamsDirectory),
    respectVideoParams: requireBoolean(raw.respectVideoParams, "respectVideoParams"),
    bitrateOverride: requireBoolean(raw.bitrateOverride, "bitrateOverride"),
    width: requireNumber(raw.width, "width", 160, 7680),
    height: requireNumber(raw.height, "height", 90, 4320),
    maxWidth: requireNumber(raw.maxWidth, "maxWidth", 0, 7680),
    maxHeight: requireNumber(raw.maxHeight, "maxHeight", 0, 4320),
    fps: requireNumber(raw.fps, "fps", 1, 120),
    bitrateKbps: requireNumber(raw.bitrateKbps, "bitrateKbps", 100, 100000),
    maxBitrateKbps: requireNumber(raw.maxBitrateKbps, "maxBitrateKbps", 100, 100000),
    hardwareAcceleration: requireBoolean(raw.hardwareAcceleration, "hardwareAcceleration"),
    videoCodec: raw.videoCodec as VideoStreamConfig["videoCodec"],
    h26xPreset: raw.h26xPreset as VideoStreamConfig["h26xPreset"],
  };
}
