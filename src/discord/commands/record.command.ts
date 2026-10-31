import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { entersState, VoiceConnectionStatus } from "@discordjs/voice";
import { ChannelType, type Message } from "discord.js";
import { recordingManager } from "../../recording/RecordingManager.ts";
import { RecordingPermissions } from "../../recording/RecordingPermissions.ts";
import { defineTextCommand } from "../commandTypes.ts";
import type { RecordingLease } from "../../voice/VoiceHub.ts";
import { say } from "../commandUtils.ts";

type RecordCommand = { sub: "start" | "stop" | "status" | "list" | "usage" };

const SUBS = ["start", "stop", "status", "list"] as const;
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
  description: "Record the voice channel (owners/admins): !record start | stop | status | list",
  parse: (content, prefix): RecordCommand | null => {
    const [first = "", sub = ""] = content.trim().split(/\s+/);
    if (first.toLowerCase() !== `${prefix}record`.toLowerCase()) return null;
    const s = sub.toLowerCase();
    return { sub: (SUBS as readonly string[]).includes(s) ? (s as RecordCommand["sub"]) : "usage" };
  },
  execute: async ({ message, guildId, deps }, cmd) => {
    const msg = message as unknown as Message<true>; // a real discord.js message at runtime
    const p = deps.prefix;

    if (cmd.sub === "usage") {
      await say(
        message,
        `**Usage:**\n\`${p}record start\` - start recording your voice channel\n\`${p}record stop\` - stop and save\n\`${p}record status\` - current recording\n\`${p}record list\` - recent recordings`,
      );
      return;
    }

    // Read-only subcommands are open to everyone allowed to use the bot; start/stop are restricted.
    if ((cmd.sub === "start" || cmd.sub === "stop") && !(msg.member && RecordingPermissions.canUserRecord(msg.member, deps.access))) {
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
          await say(message, "There is no active recording in this server.");
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
        if (!s) {
          await say(message, "No active recording in this server.");
          return;
        }
        await say(
          message,
          `📊 **Recording active**\n• Session: \`${s.sessionId}\`\n• Channel: <#${s.channelId}>\n• Started: ${s.startedAt.toISOString()}\n• Elapsed: ${s.durationSeconds}s`,
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
