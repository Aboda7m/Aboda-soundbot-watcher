import type { StreamHandle, StreamMedia, StreamStartOptions, VideoPublisher } from "./StreamProvider.ts";
import type { VideoStreamConfig } from "./videoStreamConfig.ts";

/**
 * Publishes video + audio through a USER account (a "selfbot") using the same libraries as
 * https://github.com/ysdragon/StreamBot: discord.js-selfbot-v13 + @dank074/discord-video-stream.
 *
 * Discord does not allow bot accounts to send video, so this is the only way to get a real video stream.
 * It breaks Discord's Terms of Service and can get the account banned, so it is OFF by default, needs an
 * explicit acknowledgement in videostream.json, and should only ever use a throwaway account.
 *
 * It is completely separate from the main bot's client and from VoiceHub: the streaming account has its own
 * gateway connection and its own voice connection. The two libraries are optionalDependencies and are only
 * imported when a stream is started, so the normal bot never loads them.
 */

// Minimal shapes of what we use, so this file typechecks without the optional packages installed.
export interface SelfbotClientLike {
  login(token: string): Promise<unknown>;
  once(event: "ready", listener: () => void): unknown;
  destroy(): void;
  guilds: { cache: { has(id: string): boolean } };
}
export interface StreamerLike {
  joinVoice(guildId: string, channelId: string): Promise<unknown>;
  stopStream(): void;
  leaveVoice(): void;
}
export interface SelfbotModules {
  createClient(): SelfbotClientLike;
  createStreamer(client: SelfbotClientLike): StreamerLike;
  prepareStream(input: string, options: Record<string, unknown>, signal: AbortSignal): { command: { on(event: "error", listener: (err: Error) => void): unknown }; output: unknown };
  playStream(output: unknown, streamer: StreamerLike, options: undefined, signal: AbortSignal): Promise<unknown>;
  normalizeVideoCodec(codec: string): unknown;
}

const INSTALL_HINT = "Run `npm install` (these are optionalDependencies: discord.js-selfbot-v13 and @dank074/discord-video-stream).";

/** Loads the optional packages. Specifiers are variables on purpose: this must typecheck and run when they are absent. */
export async function loadSelfbotModules(): Promise<SelfbotModules> {
  const clientPkg = "discord.js-selfbot-v13";
  const streamPkg = "@dank074/discord-video-stream";
  let clientMod: any;
  let streamMod: any;
  try {
    clientMod = await import(clientPkg);
    streamMod = await import(streamPkg);
  } catch (error) {
    throw new Error(`The video streaming libraries are not installed. ${INSTALL_HINT} (${error instanceof Error ? error.message : String(error)})`);
  }
  const Client = clientMod.Client ?? clientMod.default?.Client;
  const Streamer = streamMod.Streamer ?? streamMod.default?.Streamer;
  const Utils = streamMod.Utils ?? streamMod.default?.Utils;
  const prepareStream = streamMod.prepareStream ?? streamMod.default?.prepareStream;
  const playStream = streamMod.playStream ?? streamMod.default?.playStream;
  if (!Client || !Streamer || !prepareStream || !playStream || !Utils?.normalizeVideoCodec) {
    throw new Error(`The installed video streaming libraries do not match the expected API (discord-video-stream 6.x). ${INSTALL_HINT}`);
  }
  return {
    createClient: () => new Client() as SelfbotClientLike,
    createStreamer: (client) => new Streamer(client) as StreamerLike,
    prepareStream,
    playStream,
    normalizeVideoCodec: (codec) => Utils.normalizeVideoCodec(codec),
  };
}

export interface SelfbotPublisherOptions {
  token: string;
  config: Pick<VideoStreamConfig, "respectVideoParams" | "bitrateOverride" | "width" | "height" | "maxWidth" | "maxHeight" | "fps" | "bitrateKbps" | "maxBitrateKbps" | "hardwareAcceleration" | "videoCodec" | "h26xPreset">;
  loadModules?: () => Promise<SelfbotModules>;
  /** Pause after joining voice before sending media (StreamBot waits 2s). Tests set 0. */
  settleMs?: number;
  loginTimeoutMs?: number;
  log?: (message: string) => void;
}

export class SelfbotVideoPublisher implements VideoPublisher {
  readonly name = "user-account (selfbot) session";
  #options: SelfbotPublisherOptions;
  #modules: SelfbotModules | null = null;
  #client: SelfbotClientLike | null = null;
  #active: { guildId: string; stop: () => Promise<void> } | null = null;

  constructor(options: SelfbotPublisherOptions) {
    this.#options = options;
  }

  async #ensureClient(): Promise<SelfbotClientLike> {
    if (this.#client) return this.#client;
    const modules = (this.#modules ??= await (this.#options.loadModules ?? loadSelfbotModules)());
    const client = modules.createClient();
    const timeoutMs = this.#options.loginTimeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      client.once("ready", resolve);
      timer = setTimeout(() => reject(new Error(`The streaming account did not become ready within ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
    });
    ready.catch(() => {}); // a login failure rejects first; avoid an unhandled rejection from the timer
    try {
      await client.login(this.#options.token);
      await ready;
    } catch (error) {
      try { client.destroy(); } catch { /* already down */ }
      // Never echo the token: the library's own messages do not contain it, but be safe.
      const message = (error instanceof Error ? error.message : String(error)).split(this.#options.token).join("[token]");
      throw new Error(`Could not log in the streaming account: ${message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.#client = client;
    return client;
  }

  /** The options the library expects, mirroring StreamBot's setupStreamConfiguration. */
  buildStreamOptions(media: StreamMedia, normalizeVideoCodec: (codec: string) => unknown): Record<string, unknown> {
    const c = this.#options.config;
    let width = (c.respectVideoParams && media.width) || c.width;
    let height = (c.respectVideoParams && media.height) || c.height;
    const frameRate = (c.respectVideoParams && media.fps) || c.fps;
    let bitrateVideo = c.bitrateKbps;
    if (c.respectVideoParams && media.bitrateKbps && !c.bitrateOverride) bitrateVideo = media.bitrateKbps;

    if (c.maxWidth > 0 || c.maxHeight > 0) {
      const ratio = width / height;
      if (c.maxWidth > 0 && width > c.maxWidth) { width = c.maxWidth; height = Math.round(width / ratio); }
      if (c.maxHeight > 0 && height > c.maxHeight) { height = c.maxHeight; width = Math.round(height * ratio); }
      width = Math.round(width / 2) * 2;
      height = Math.round(height / 2) * 2;
    }
    return {
      width,
      height,
      frameRate,
      bitrateVideo,
      bitrateVideoMax: Math.max(c.maxBitrateKbps, bitrateVideo),
      videoCodec: normalizeVideoCodec(c.videoCodec),
      hardwareAcceleratedDecoding: c.hardwareAcceleration,
      minimizeLatency: false,
      h26xPreset: c.h26xPreset,
    };
  }

  async publish(request: StreamStartOptions & { media: StreamMedia }): Promise<StreamHandle> {
    const codec = this.#options.config.videoCodec;
    if (codec !== "H264" && codec !== "H265" && codec !== "VP8") {
      throw new Error(`videostream.json: videoCodec ${codec} is not supported by the streaming library. Use H264, H265 or VP8.`);
    }
    if (this.#active) {
      throw new Error(`The streaming account is already streaming in server ${this.#active.guildId}. Use !streamstop there first.`);
    }

    const log = this.#options.log ?? (() => {});
    const controller = new AbortController();
    let streamer: StreamerLike | null = null;
    let errorMessage: string | null = null;
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try { streamer?.stopStream(); } catch { /* not streaming */ }
      try { streamer?.leaveVoice(); } catch { /* not connected */ }
      this.#active = null;
    };
    // Reserve the account before any await so a second !stream cannot race in.
    this.#active = {
      guildId: request.guildId,
      stop: async () => { controller.abort(); cleanup(); },
    };

    try {
      const client = await this.#ensureClient();
      if (!client.guilds.cache.has(request.guildId)) {
        throw new Error("The streaming account is not a member of this server. Invite that account to the server first.");
      }
      const modules = this.#modules!;
      streamer = modules.createStreamer(client);
      await streamer.joinVoice(request.guildId, request.channelId);
      await new Promise((resolve) => setTimeout(resolve, this.#options.settleMs ?? 2000));
      if (controller.signal.aborted) throw new Error("The stream was stopped while starting.");

      const { command, output } = modules.prepareStream(request.filePath, this.buildStreamOptions(request.media, modules.normalizeVideoCodec), controller.signal);
      command.on("error", (err) => {
        if (controller.signal.aborted) return;
        errorMessage = `ffmpeg failed: ${err.message}`;
        log(`[stream] ${errorMessage}`);
        controller.abort();
      });

      const ended: Promise<string | null> = modules.playStream(output, streamer, undefined, controller.signal).then(
        () => errorMessage,
        (err: unknown) => (controller.signal.aborted && !errorMessage ? null : errorMessage ?? `Streaming failed: ${err instanceof Error ? err.message : String(err)}`),
      ).then((result) => { cleanup(); return result; });

      return {
        startedAt: Date.now(),
        ended,
        stop: async () => {
          controller.abort();
          await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5000))]);
          cleanup();
        },
      };
    } catch (error) {
      controller.abort();
      cleanup();
      throw error;
    }
  }

  /** Disconnects the streaming account (used on shutdown). */
  async shutdown(): Promise<void> {
    await this.#active?.stop();
    try { this.#client?.destroy(); } catch { /* already down */ }
    this.#client = null;
  }
}

/** Builds the publisher from videostream.json + environment, or explains exactly why there is none. */
export function createVideoPublisher(
  config: VideoStreamConfig,
  env: Record<string, string | undefined>,
  deps: Pick<SelfbotPublisherOptions, "loadModules" | "settleMs" | "log"> = {},
): { publisher?: SelfbotVideoPublisher; problem?: string } {
  if (config.publisher === "disabled") return {};
  const token = env.STREAM_SELFBOT_TOKEN?.trim();
  if (!config.selfbotAcknowledgeTosRisk) {
    return { problem: 'videostream.json has "publisher": "selfbot" but "selfbotAcknowledgeTosRisk" is not true. Video streaming stays disabled until you accept that a user-account session breaks Discord\'s Terms of Service.' };
  }
  if (!token) {
    return { problem: "videostream.json has \"publisher\": \"selfbot\" but STREAM_SELFBOT_TOKEN is not set in .env. Video streaming stays disabled." };
  }
  return { publisher: new SelfbotVideoPublisher({ token, config, ...deps }) };
}
