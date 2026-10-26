import fs from 'node:fs';
import path from 'node:path';
import type { VoiceState } from 'discord.js';

const LOG_FILE_PATH = path.join(process.cwd(), 'voice-activity-logs.json');

interface VoiceLogRecord {
  timestamp: string;
  action: 'JOIN' | 'DISCONNECT' | 'MOVE';
  userId: string;
  guildId: string;
  username: string;
  guildName: string;
  channelName: string | null;
  previousChannelName?: string | null;
}

export function trackVoiceActivity(oldState: VoiceState, newState: VoiceState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return; // Skip bot accounts if desired

  const username = member.user.tag || member.user.username;
  const userId = member.id;
  const guildName = newState.guild.name || oldState.guild.name;

  let action: 'JOIN' | 'DISCONNECT' | 'MOVE' | null = null;

  if (!oldState.channelId && newState.channelId) {
    action = 'JOIN';
  } else if (oldState.channelId && !newState.channelId) {
    action = 'DISCONNECT';
  } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    action = 'MOVE';
  }

  // If the event was just a mute, deafen, or streaming update, skip it
  if (!action) return;

  const record: VoiceLogRecord = {
    timestamp: new Date().toISOString(),
    action,
    userId,
    guildId: newState.guild.id || oldState.guild.id,
    username,
    guildName,
    channelName: newState.channel?.name || null,
    previousChannelName: oldState.channel?.name || null,
  };

  // Load existing logs or initialize a clean array
  let logs: VoiceLogRecord[] = [];
  if (fs.existsSync(LOG_FILE_PATH)) {
    try {
      const fileContent = fs.readFileSync(LOG_FILE_PATH, 'utf-8');
      logs = JSON.parse(fileContent);
    } catch {
      logs = [];
    }
  }

  logs.push(record);

  // Write back atomically using pretty JSON format
  fs.writeFileSync(LOG_FILE_PATH, JSON.stringify(logs, null, 2), 'utf-8');
}