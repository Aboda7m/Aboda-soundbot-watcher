import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus } from "@discordjs/voice";
import type { Client } from "discord.js";
import { DiscordVoiceAdapter } from "./DiscordVoiceAdapter.ts";

const READY_TIMEOUT_MS = 15_000;
let nextGuild = 0;

/** A guild with two voice channels whose gateway adapter just records what the library tries to send. */
function setup() {
  const guildId = `rec-test-guild-${++nextGuild}`;
  const payloads: { channel_id: string | null; self_deaf: boolean }[] = [];
  const voiceAdapterCreator = () => ({
    sendPayload: (p: { d: { channel_id: string | null; self_deaf: boolean } }) => {
      payloads.push(p.d);
      return true;
    },
    destroy: () => {},
  });
  const channel = (name: string) => ({ name, isVoiceBased: () => true, joinable: true, speakable: true });
  const client = {
    guilds: {
      cache: new Map([[guildId, { voiceAdapterCreator, channels: { cache: new Map([["chanA", channel("A")], ["chanB", channel("B")]]) } }]]),
    },
  } as unknown as Client;

  /** What the record command does: join with selfDeaf:false. */
  const joinForRecording = (channelId = "chanA") =>
    joinVoiceChannel({ guildId, channelId, adapterCreator: voiceAdapterCreator as never, selfDeaf: false, selfMute: false });

  /** Runs play() into the connect timeout: the voice handshake never completes in a test. */
  const playUntilTimeout = async (adapter: DiscordVoiceAdapter, channelId = "chanA") => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const playing = adapter.play(guildId, channelId, "unused.opus");
      const outcome = assert.rejects(playing);
      mock.timers.tick(READY_TIMEOUT_MS + 1);
      await outcome;
    } finally {
      mock.timers.reset();
    }
  };
  const alive = () => {
    const c = getVoiceConnection(guildId);
    return c !== undefined && c.state.status !== VoiceConnectionStatus.Destroyed;
  };
  return { guildId, client, payloads, joinForRecording, playUntilTimeout, alive };
}

test("control: without a recording, finishing/failing playback tears the connection down", async () => {
  const t = setup();
  const adapter = new DiscordVoiceAdapter(t.client, { isPinned: () => false });
  t.joinForRecording();
  await t.playUntilTimeout(adapter);
  assert.equal(t.alive(), false);
});

test("playback cleanup cannot destroy a connection an active recording needs", async () => {
  const t = setup();
  let recording = true;
  const adapter = new DiscordVoiceAdapter(t.client, { isPinned: () => recording });
  const connection = t.joinForRecording();

  await t.playUntilTimeout(adapter); // the failure path calls leave() internally
  assert.equal(t.alive(), true, "connection must survive the failed/finished playback");

  adapter.leave(t.guildId); // what the queue's idle timer does after the last sound
  assert.equal(t.alive(), true, "idle leave must not destroy the recording connection");

  recording = false; // recording stopped: normal cleanup works again
  adapter.leave(t.guildId);
  assert.equal(connection.state.status, VoiceConnectionStatus.Destroyed);
});

test("a sound played during a recording never re-joins the connection deafened", async () => {
  const t = setup();
  const adapter = new DiscordVoiceAdapter(t.client, { isPinned: () => true });
  t.joinForRecording();
  t.payloads.length = 0;

  await t.playUntilTimeout(adapter);
  assert.ok(t.payloads.length > 0, "the adapter re-sent a join");
  assert.ok(t.payloads.every((p) => p.self_deaf === false), "self_deaf must stay false or the bot receives no audio");
  getVoiceConnection(t.guildId)?.destroy();
});

test("a sound for another channel cannot move the recording connection", async () => {
  const t = setup();
  const adapter = new DiscordVoiceAdapter(t.client, { isPinned: () => true });
  const connection = t.joinForRecording("chanA");
  t.payloads.length = 0;

  await assert.rejects(adapter.play(t.guildId, "chanB", "unused.opus"), /recording is active in another voice channel/);
  assert.equal(connection.joinConfig.channelId, "chanA");
  assert.equal(t.payloads.length, 0, "no join for the other channel may be sent");
  assert.equal(t.alive(), true);
  connection.destroy();
});

test("shutdown (destroyAll) still tears everything down, even during a recording", async () => {
  const t = setup();
  const adapter = new DiscordVoiceAdapter(t.client, { isPinned: () => true });
  t.joinForRecording();
  await t.playUntilTimeout(adapter);
  adapter.destroyAll();
  assert.equal(t.alive(), false);
});
