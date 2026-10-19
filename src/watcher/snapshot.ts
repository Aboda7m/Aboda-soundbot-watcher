import type { Client } from "discord.js";

export interface MemberInfo {
  id: string;
  name: string;
  avatar: string | null;
  bot: boolean;
  muted: boolean;
  deafened: boolean;
  streaming: boolean;
  camera: boolean;
}
export interface ChannelInfo {
  id: string;
  name: string;
  members: MemberInfo[];
}
export interface GuildInfo {
  id: string;
  name: string;
  channels: ChannelInfo[];
}
export interface Snapshot {
  ready: boolean;
  total: number;
  guilds: GuildInfo[];
}

export function buildSnapshot(client: Client, hideBots: boolean): Snapshot {
  const guilds: GuildInfo[] = [];
  let total = 0;

  for (const guild of client.guilds.cache.values()) {
    if (!guild.available) continue;

    const channels = new Map<string, { pos: number; info: ChannelInfo }>();

    for (const vs of guild.voiceStates.cache.values()) {
      const channel = vs.channel;
      if (!channel) continue;
      const member = vs.member;
      if (hideBots && member?.user.bot) continue;

      let entry = channels.get(channel.id);
      if (!entry) {
        entry = { pos: channel.rawPosition, info: { id: channel.id, name: channel.name, members: [] } };
        channels.set(channel.id, entry);
      }

      entry.info.members.push({
        id: vs.id,
        name: member?.displayName ?? member?.user.username ?? "Unknown user",
        avatar: member?.displayAvatarURL({ size: 64, extension: "png" }) ?? null,
        bot: member?.user.bot ?? false,
        muted: !!(vs.selfMute || vs.serverMute),
        deafened: !!(vs.selfDeaf || vs.serverDeaf),
        streaming: !!vs.streaming,
        camera: !!vs.selfVideo,
      });
      total++;
    }

    if (channels.size === 0) continue;

    const sorted = [...channels.values()]
      .sort((a, b) => a.pos - b.pos)
      .map(({ info }) => {
        info.members.sort((a, b) => a.name.localeCompare(b.name));
        return info;
      });
    guilds.push({ id: guild.id, name: guild.name, channels: sorted });
  }

  guilds.sort((a, b) => a.name.localeCompare(b.name));
  return { ready: client.isReady(), total, guilds };
}
