import {
  AudioPlayerStatus,
  createAudioPlayer,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Client } from "discord.js";
import { recordingManager } from "../recording/RecordingManager.ts";
import { createResource } from "./AudioProvider.ts";
import type { VoicePort } from "./VoicePort.ts";

const READY_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 15_000;

interface GuildVoice {
  connection: VoiceConnection;
  player: AudioPlayer;
  channelId: string;
}

export interface DiscordVoiceAdapterOptions {
  group?: string;
  /**
   * True while something else (an active recording) needs this guild's voice connection: playback must then
   * never destroy it, move it to another channel, or re-join it deafened. Default: a recording is active.
   */
  isPinned?: (guildId: string) => boolean;
}

/** One voice connection + one player per guild. Everything @discordjs/voice-specific for connections is here. */
export class DiscordVoiceAdapter implements VoicePort {
  #client: Client;
  #isPinned: (guildId: string) => boolean;
  #group: string;
  #guilds = new Map<string, GuildVoice>();

  constructor(client: Client, options: DiscordVoiceAdapterOptions = {}) {
    this.#client = client;
    this.#group = options.group ?? client.user?.id ?? "voice-main";
    this.#isPinned = options.isPinned ?? ((guildId) => recordingManager.isRecording(guildId));
  }

  async play(guildId: string, channelId: string, filePath: string, maxDurationSec?: number, onStarted?: () => void): Promise<void> {
    const { player } = await this.#ensure(guildId, channelId);
    const resource = createResource(filePath);

    await new Promise<void>((resolve, reject) => {
      let started = false;
      let durationTimer: NodeJS.Timeout | null = null;
      const startTimer = setTimeout(() => {
        cleanup();
        player.stop(true);
        reject(new Error("Playback did not start in time"));
      }, START_TIMEOUT_MS);

      const onState = (_old: unknown, next: { status: AudioPlayerStatus }) => {
        if (next.status === AudioPlayerStatus.Playing) {
          if (!started) {
            started = true;
            clearTimeout(startTimer);
            onStarted?.();
            if (Number.isInteger(maxDurationSec) && maxDurationSec! >= 1 && maxDurationSec! <= 30) {
              durationTimer = setTimeout(() => player.stop(true), maxDurationSec! * 1000);
              durationTimer.unref();
            }
          }
        } else if (next.status === AudioPlayerStatus.Idle && started) {
          cleanup();
          resolve();
        }
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(startTimer);
        if (durationTimer) clearTimeout(durationTimer);
        durationTimer = null;
        player.off("stateChange", onState);
        player.off("error", onError);
      };

      player.on("stateChange", onState);
      player.on("error", onError);
      player.play(resource);
    });
  }

  stop(guildId: string, channelId?: string) {
    const gv = this.#guilds.get(guildId);
    if (!channelId || gv?.channelId === channelId) gv?.player.stop(true);
  }

  canServe(guildId: string): boolean {
    return !!this.#client.isReady() && this.#client.guilds.cache.has(guildId);
  }

  channelOf(guildId: string): string | null {
    const gv = this.#guilds.get(guildId);
    return gv && gv.connection.state.status !== VoiceConnectionStatus.Destroyed ? gv.channelId : null;
  }

  async connect(guildId: string, channelId: string): Promise<VoiceConnection> {
    return (await this.#ensure(guildId, channelId, true)).connection;
  }

  /** Playback is done with this guild. Does nothing while a recording still needs the connection. */
  leave(guildId: string, channelId?: string) {
    if (this.#isPinned(guildId)) return;
    if (channelId && this.#guilds.get(guildId)?.channelId !== channelId) return;
    this.#destroy(guildId);
  }

  /** Shutdown: tears everything down regardless of recordings. */
  destroyAll() {
    for (const id of [...this.#guilds.keys()]) this.#destroy(id);
  }

  #destroy(guildId: string) {
    const gv = this.#guilds.get(guildId);
    if (gv && gv.connection.state.status !== VoiceConnectionStatus.Destroyed) gv.connection.destroy();
    this.#guilds.delete(guildId);
  }

  async #ensure(guildId: string, channelId: string, listening = false): Promise<GuildVoice> {
    const guild = this.#client.guilds.cache.get(guildId);
    if (!guild) throw new Error(`Guild ${guildId} is not available`);

    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) throw new Error(`Channel ${channelId} is not a voice channel`);
    if (!channel.joinable || ('speakable' in channel && !channel.speakable))
      throw new Error(`Missing permission (or channel full) to connect/speak in "${channel.name}"`);

    // A recording owns the connection: never move it to another channel for a sound.
    const pinned = this.#isPinned(guildId);
    const live = pinned ? getVoiceConnection(guildId, this.#group) : undefined;
    if (live && live.joinConfig.channelId !== channelId)
      throw new Error(`A recording is active in another voice channel of this server; cannot play in "${channel.name}"`);

    let gv = this.#guilds.get(guildId);
    if (gv && (gv.connection.state.status === VoiceConnectionStatus.Destroyed || gv.channelId !== channelId)) {
      this.#destroy(guildId); // dead connection, or a different channel: start clean
      gv = undefined;
    }

    if (!gv) {
      const player = createAudioPlayer();
      const connection = joinVoiceChannel({
        guildId,
        channelId,
        adapterCreator: guild.voiceAdapterCreator,
        // Re-joining an existing (recording) connection sends these options again; a deafened bot receives no audio.
        selfDeaf: false,
        group: this.#group,
      });
      gv = { connection, player, channelId };
      this.#guilds.set(guildId, gv);
      this.#watchConnection(guildId, gv);
      connection.subscribe(player);
    }

    try {
      await entersState(gv.connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch {
      this.leave(guildId);
      throw new Error(`Could not connect to voice channel "${channel.name}" in time`);
    }
    return gv;
  }

  #watchConnection(guildId: string, gv: GuildVoice) {
    const { connection, player } = gv;
    connection.on("error", (err) => console.error(`[voice ${guildId}]`, err.message));
    // Standard recovery: if Discord moved/disconnected us, give it a few seconds to reconnect, else clean up.
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      player.stop(true);
      if (this.#guilds.get(guildId) === gv) this.#guilds.delete(guildId);
    });
  }
}
