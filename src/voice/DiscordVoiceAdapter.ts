import {
  AudioPlayerStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Client } from "discord.js";
import { createResource } from "./AudioProvider.ts";
import type { VoicePort } from "./VoicePort.ts";

const READY_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 15_000;

interface GuildVoice {
  connection: VoiceConnection;
  player: AudioPlayer;
  channelId: string;
}

/** One voice connection + one player per guild. Everything @discordjs/voice-specific for connections is here. */
export class DiscordVoiceAdapter implements VoicePort {
  #client: Client;
  #guilds = new Map<string, GuildVoice>();

  constructor(client: Client) {
    this.#client = client;
  }

  async play(guildId: string, channelId: string, filePath: string): Promise<void> {
    const { player } = await this.#ensure(guildId, channelId);
    const resource = createResource(filePath);

    await new Promise<void>((resolve, reject) => {
      let started = false;
      const startTimer = setTimeout(() => {
        cleanup();
        player.stop(true);
        reject(new Error("Playback did not start in time"));
      }, START_TIMEOUT_MS);

      const onState = (_old: unknown, next: { status: AudioPlayerStatus }) => {
        if (next.status === AudioPlayerStatus.Playing) {
          started = true;
          clearTimeout(startTimer);
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
        player.off("stateChange", onState);
        player.off("error", onError);
      };

      player.on("stateChange", onState);
      player.on("error", onError);
      player.play(resource);
    });
  }

  stop(guildId: string) {
    this.#guilds.get(guildId)?.player.stop(true);
  }

  leave(guildId: string) {
    const gv = this.#guilds.get(guildId);
    if (gv && gv.connection.state.status !== VoiceConnectionStatus.Destroyed) gv.connection.destroy();
    this.#guilds.delete(guildId);
  }

  destroyAll() {
    for (const id of [...this.#guilds.keys()]) this.leave(id);
  }

  async #ensure(guildId: string, channelId: string): Promise<GuildVoice> {
    const guild = this.#client.guilds.cache.get(guildId);
    if (!guild) throw new Error(`Guild ${guildId} is not available`);

    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) throw new Error(`Channel ${channelId} is not a voice channel`);
    if (!channel.joinable || ('speakable' in channel && !channel.speakable))
      throw new Error(`Missing permission (or channel full) to connect/speak in "${channel.name}"`);

    let gv = this.#guilds.get(guildId);
    if (gv && (gv.connection.state.status === VoiceConnectionStatus.Destroyed || gv.channelId !== channelId)) {
      this.leave(guildId); // dead connection, or a different channel: start clean
      gv = undefined;
    }

    if (!gv) {
      const player = createAudioPlayer();
      const connection = joinVoiceChannel({
        guildId,
        channelId,
        adapterCreator: guild.voiceAdapterCreator,
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
