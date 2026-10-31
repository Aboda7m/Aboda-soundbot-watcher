import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { entersState, VoiceConnectionStatus } from "@discordjs/voice";
import { ChannelType, type Message } from "discord.js";
import { recordingManager } from "../../recording/RecordingManager.ts";
import { RecordingPermissions } from "../../recording/RecordingPermissions.ts";
import { defineTextCommand } from "../commandTypes.ts";
import type { RecordingLease } from "../../voice/VoiceHub.ts";
import { NO_MENTIONS, say } from "../commandUtils.ts";

type RecordCommand = { sub: "start" | "stop" | "status" | "list" | "attach" | "detach" | "usage"; targetId?: string };

const SUBS = ["start", "stop", "status", "list", "attach", "detach"] as const;
/** A user mention (`<@123>` / `<@!123>`) or a raw user id. */
const USER_ARG = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/;
const leases = new Map<string, RecordingLease>();

/** Newest session ids (folder names sort by timestamp) for one guild. */
async function listSessions(guildId: string, limit: number): Promise<string[]> {
  const root = join(recordingManager.baseDir, "guilds", guildId);
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (depth === 3) found.push(e.name);
      else await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0); // root/YYYY/MM/DD/<session>
  return found.sort().reverse().slice(0, limit);
}

export default defineTextCommand({
  names: ["record"],
  description: "Record the voice channel (owners/admins): !record start | stop | status | list | attach @user | detach",
  parse: (content, prefix): RecordCommand | null => {
    const [first = "", sub = "", arg = ""] = content.trim().split(/\s+/);
    if (first.toLowerCase() !== `${prefix}record`.toLowerCase()) return null;
    const s = sub.toLowerCase();
    if (!(SUBS as readonly string[]).includes(s)) return { sub: "usage" };
    const targetId = s === "attach" ? USER_ARG.exec(arg)?.slice(1).find(Boolean) : undefined;
    return { sub: s as RecordCommand["sub"], ...(targetId ? { targetId } : {}) };
  },
  execute: async ({ message, guildId, deps }, cmd) => {
    const msg = message as unknown as Message<true>; // a real discord.js message at runtime
    const p = deps.prefix;

    if (cmd.sub === "usage") {
      await say(
        message,
        `**Usage:**\n\`${p}record start\` - start recording your voice channel\n\`${p}record stop\` - stop and save\n\`${p}record status\` - current recording\n\`${p}record list\` - recent recordings\n\`${p}record attach @user\` - follow a user across voice channels and record them\n\`${p}record detach\` - stop following`,
      );
      return;
    }

    // Read-only subcommands are open to everyone allowed to use the bot; the rest are restricted.
    if ((cmd.sub === "start" || cmd.sub === "stop" || cmd.sub === "attach" || cmd.sub === "detach") && !(msg.member && RecordingPermissions.canUserRecord(msg.member, deps.access))) {
      await say(message, "You do not have permission to manage recordings (owner, Administrator, or Manage Channels + Move Members).");
      return;
    }

    switch (cmd.sub) {
      case "start": {
        const voiceChannel = msg.member?.voice.channel;
        if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
          await say(message, "Join a voice channel first.");
          return;
        }
        if (recordingManager.isRecording(guildId)) {
          await say(message, `A recording is already active in this server. Use \`${p}record status\`.`);
          return;
        }
        let lease: RecordingLease;
        try {
          lease = await deps.voiceHub.leaseRecording(guildId, voiceChannel.id);
        } catch (err) {
          await say(message, `Could not allocate a recording bot: ${(err as Error).message}`);
          return;
        }
        const connection = lease.connection;

        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
          const session = await recordingManager.startSession(guildId, voiceChannel.id, msg.author.id, connection, {
            guildName: msg.guild.name,
            channelName: voiceChannel.name,
            initiatedByName: msg.member?.displayName ?? msg.author.username,
            resolveUserName: (id) => msg.guild.members.cache.get(id)?.displayName ?? msg.client.users.cache.get(id)?.username,
          });
          if (!session) {
            deps.voiceHub.releaseRecording(guildId, voiceChannel.id, lease.slotId);
            await say(message, "A recording is already active in this server.");
            return;
          }
          leases.set(guildId, lease);

          // If the bot gets kicked/moved and cannot reconnect, save what we have.
          connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
              await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
              ]);
            } catch {
              if (recordingManager.getSession(guildId) === session) {
                await recordingManager.stopSession(guildId, true);
                deps.voiceHub.releaseRecording(guildId, voiceChannel.id, lease.slotId);
                leases.delete(guildId);
                await msg.channel.send(`⚠️ Recording \`${session.sessionId}\` was interrupted (disconnected). What was captured is saved.`).catch(() => {});
              }
              if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
            }
          });

          await say(
            message,
            `🔴 Recording started in **${voiceChannel.name}**. Everyone in the channel is being recorded.\nSession: \`${session.sessionId}\``,
          );
        } catch (err) {
          console.error("record start failed:", err);
          await recordingManager.stopSession(guildId, true).catch(() => {});
          deps.voiceHub.releaseRecording(guildId, voiceChannel.id, lease.slotId);
          leases.delete(guildId);
          await say(message, "Could not start recording (failed to join the voice channel in time).");
        }
        return;
      }

      case "stop": {
        const session = await recordingManager.stopSession(guildId);
        if (!session) {
          const following = deps.followRecorder.get(guildId);
          await say(
            message,
            following
              ? `There is no active recording in this server. A follow on <@${following.targetId}> is registered: use \`${p}record detach\` to stop it.`
              : "There is no active recording in this server.",
          );
          return;
        }
        // stopSession resolved, so every file is fully flushed: only now may the connection go. If sounds are
        // still playing or queued the queue's own idle-leave (now allowed, the recording is over) closes it.
        const lease = leases.get(guildId);
        if (lease) deps.voiceHub.releaseRecording(guildId, session.channelId, lease.slotId);
        leases.delete(guildId);
        await say(message, `⏹️ Recording saved.\nSession: \`${session.sessionId}\`\nDuration: ${session.durationSeconds}s`);
        return;
      }

      case "status": {
        const s = recordingManager.getSession(guildId);
        const f = deps.followRecorder.get(guildId);
        const parts = [
          s
            ? `📊 **Recording active**\n• Session: \`${s.sessionId}\`\n• Channel: <#${s.channelId}>\n• Started: ${s.startedAt.toISOString()}\n• Elapsed: ${s.durationSeconds}s`
            : "No active recording in this server.",
        ];
        if (f?.session) {
          parts.push(
            `👁️ **Following** <@${f.targetId}>\n• Session: \`${f.session.sessionId}\`\n• Channel: <#${f.session.channelId}>\n• Started: ${f.session.startedAt.toISOString()}\n• Elapsed: ${f.session.durationSeconds}s`,
          );
        } else if (f) {
          parts.push(`👁️ **Following** <@${f.targetId}> (not recording: waiting for them to join a voice channel)`);
        }
        await say(message, parts.join("\n\n"));
        return;
      }

      case "attach": {
        if (!cmd.targetId) {
          await say(message, `Usage: \`${p}record attach @user\``);
          return;
        }
        const target = msg.guild.members.cache.get(cmd.targetId) ?? (await msg.guild.members.fetch(cmd.targetId).catch(() => null));
        if (!target) {
          await say(message, "I could not find that user in this server.");
          return;
        }
        if (target.user.bot) {
          await say(message, "I can only follow human users, not bots.");
          return;
        }
        const targetChannel = target.voice.channel?.type === ChannelType.GuildVoice ? target.voice.channel : null;
        const result = await deps.followRecorder.attach({
          guildId,
          targetId: target.id,
          initiatedBy: msg.author.id,
          targetChannelId: targetChannel?.id ?? null,
          context: {
            guildName: msg.guild.name,
            initiatedByName: msg.member?.displayName ?? msg.author.username,
            channelName: (id) => msg.guild.channels.cache.get(id)?.name,
            resolveUserName: (id) => msg.guild.members.cache.get(id)?.displayName ?? msg.client.users.cache.get(id)?.username,
            notify: (text) => msg.channel.send({ content: text, allowedMentions: NO_MENTIONS }),
          },
        });
        if (!result.ok) {
          await say(message, `Already following <@${result.targetId}> in this server. Use \`${p}record detach\` first.`);
          return;
        }
        const who = `<@${target.id}>`;
        if (result.session) {
          await say(
            message,
            `🔴 ${result.already ? "Already following" : "Now following"} ${who}. Recording in <#${result.session.channelId}>; it moves with them and stops when they leave voice.\nSession: \`${result.session.sessionId}\``,
          );
        } else if (result.error) {
          await say(message, `👁️ Following ${who}, but recording could not start now: ${result.error}\nIt retries on their next voice update.`);
        } else {
          await say(message, `👁️ ${result.already ? "Already following" : "Now following"} ${who}. Recording starts when they join a voice channel.`);
        }
        return;
      }

      case "detach": {
        const result = await deps.followRecorder.detach(guildId);
        if (!result.ok) {
          await say(message, "Not following anyone in this server.");
          return;
        }
        await say(
          message,
          result.session
            ? `⏹️ Stopped following <@${result.targetId}>. Recording saved.\nSession: \`${result.session.sessionId}\`\nDuration: ${result.session.durationSeconds}s`
            : `Stopped following <@${result.targetId}>.`,
        );
        return;
      }

      case "list": {
        const ids = await listSessions(guildId, 10);
        await say(message, ids.length ? `📂 **Recent recordings:**\n${ids.map((i) => `• \`${i}\``).join("\n")}` : "No recordings found for this server.");
        return;
      }
    }
  },
});
