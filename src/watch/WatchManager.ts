import type { ServerResponse } from "node:http";
import { isIP } from "node:net";

export interface WatchParticipant {
  userId: string;
  username: string;
  channelId: string;
  guildId: string;
  joinedAt: number;
}
export interface WatchMedia { url: string; title: string; kind: "html5" | "youtube"; youtubeId?: string; }
export interface WatchRoomSnapshot {
  guildId: string; guildName: string; channelId: string; channelName: string;
  media: WatchMedia | null;
  playback: { paused: boolean; position: number; playbackRate: number; updatedAt: number };
  participants: WatchParticipant[];
  updatedAt: number;
}
type Room = WatchRoomSnapshot & { clients: Set<ServerResponse>; emptyAt: number | null };
const keyOf = (guildId: string, channelId: string) => `${guildId}:${channelId}`;
const youtubeId = (raw: string): string | null => {
  try {
    const u = new URL(raw);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(u.hostname)) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/); return m?.[1] ?? null;
    }
  } catch { /* invalid URL */ }
  return null;
};

/** In-memory watch state. Discord voice membership is the source of truth for room participation. */
export class WatchManager {
  #rooms = new Map<string, Room>();
  #emptyTtlMs: number;
  #userRooms = new Map<string, Set<string>>();
  #sweep: NodeJS.Timeout;
  #sync: NodeJS.Timeout;
  constructor(emptyTtlMs = 10 * 60_000) {
    this.#emptyTtlMs = emptyTtlMs;
    this.#sweep = setInterval(() => this.sweep(), 30_000);
    this.#sync = setInterval(() => { for (const room of this.#rooms.values()) if (room.clients.size) this.broadcast(room); }, 5_000);
    this.#sweep.unref(); this.#sync.unref();
  }
  updateVoice(input: { guildId: string; guildName: string; userId: string; username: string; channelId: string | null; channelName?: string }) {
    const userKey = `${input.guildId}:${input.userId}`;
    const previous = this.#userRooms.get(userKey);
    if (previous) for (const key of previous) {
      const room = this.#rooms.get(key);
      if (!room) continue;
      room.participants = room.participants.filter((p) => p.userId !== input.userId);
      if (!room.participants.length) room.emptyAt = Date.now();
      room.updatedAt = Date.now(); this.broadcast(room);
    }
    this.#userRooms.delete(userKey);
    if (!input.channelId) return;
    const key = keyOf(input.guildId, input.channelId);
    let room = this.#rooms.get(key);
    if (!room) {
      room = { guildId: input.guildId, guildName: input.guildName, channelId: input.channelId, channelName: input.channelName ?? "Voice channel", media: null,
        playback: { paused: true, position: 0, playbackRate: 1, updatedAt: Date.now() }, participants: [], updatedAt: Date.now(), clients: new Set(), emptyAt: null };
      this.#rooms.set(key, room);
    }
    room.guildName = input.guildName; room.channelName = input.channelName ?? room.channelName;
    room.participants = room.participants.filter((p) => p.userId !== input.userId);
    room.participants.push({ userId: input.userId, username: input.username, guildId: input.guildId, channelId: input.channelId, joinedAt: Date.now() });
    room.emptyAt = null; room.updatedAt = Date.now();
    this.#userRooms.set(userKey, new Set([key]));
    this.broadcast(room);
  }
  roomsForUser(userId: string): WatchRoomSnapshot[] {
    const keys = [...this.#userRooms.entries()].filter(([key]) => key.endsWith(`:${userId}`)).flatMap(([, values]) => [...values]);
    return keys.map((key) => this.#rooms.get(key)).filter((r): r is Room => !!r).map((r) => this.snapshot(r));
  }
  getRoom(guildId: string, channelId: string): Room | null { return this.#rooms.get(keyOf(guildId, channelId)) ?? null; }
  snapshot(room: Room): WatchRoomSnapshot {
    const playback = { ...room.playback };
    if (!playback.paused) playback.position += Math.max(0, (Date.now() - playback.updatedAt) / 1000) * playback.playbackRate;
    return { guildId: room.guildId, guildName: room.guildName, channelId: room.channelId, channelName: room.channelName, media: room.media ? { ...room.media } : null, playback, participants: room.participants.map((p) => ({ ...p })), updatedAt: room.updatedAt };
  }
  attach(room: Room, res: ServerResponse) {
    room.clients.add(res); res.write(`event: state\ndata: ${JSON.stringify(this.snapshot(room))}\n\n`);
    const timer = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 20_000); timer.unref();
    res.on("close", () => { clearInterval(timer); room.clients.delete(res); });
  }
  command(room: Room, userId: string, command: Record<string, unknown>) {
    if (!room.participants.some((p) => p.userId === userId)) throw new Error("You must be in this Discord voice channel to control its watch room.");
    const now = Date.now();
    const current = this.snapshot(room).playback;
    switch (command.action) {
      case "play": room.playback = { ...current, paused: false, updatedAt: now }; break;
      case "pause": room.playback = { ...current, paused: true, updatedAt: now }; break;
      case "seek": {
        const position = Number(command.position);
        if (!Number.isFinite(position) || position < 0 || position > 60 * 60 * 24) throw new Error("Invalid playback position.");
        room.playback = { ...current, position, updatedAt: now }; break;
      }
      case "rate": {
        const playbackRate = Number(command.rate);
        if (![0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(playbackRate)) throw new Error("Unsupported playback speed.");
        room.playback = { ...current, playbackRate, updatedAt: now }; break;
      }
      case "media": {
        const url = String(command.url ?? "").trim();
        let parsed: URL; try { parsed = new URL(url); } catch { throw new Error("Enter a valid video URL."); }
        if (!(["https:", "http:"].includes(parsed.protocol))) throw new Error("Only HTTP and HTTPS media URLs are supported.");
        if (parsed.username || parsed.password) throw new Error("Media URLs must not contain embedded credentials.");
        const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal")) throw new Error("Local-network media URLs are not allowed. Use a public HTTPS media URL.");
        if (isIP(host) === 4) {
          const octets = host.split(".").map(Number);
          if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168)) throw new Error("Private-network media URLs are not allowed.");
        }
        if (isIP(host) === 6 && (host === "::" || host === "::1" || host.toLowerCase().startsWith("fc") || host.toLowerCase().startsWith("fd") || host.toLowerCase().startsWith("fe80:"))) throw new Error("Private-network media URLs are not allowed.");
        const yt = youtubeId(url);
        if (!yt && parsed.pathname.toLowerCase().endsWith(".m3u8")) throw new Error("HLS playback is not enabled in this first version. Use a direct MP4/WebM URL or YouTube.");
        if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host) && !yt) throw new Error("That YouTube URL does not contain a valid video ID.");
        if (yt && !/^[A-Za-z0-9_-]{11}$/.test(yt)) throw new Error("That YouTube URL does not contain a valid video ID.");
        room.media = { url, title: String(command.title ?? (yt ? "YouTube video" : "Shared video")).slice(0, 180), kind: yt ? "youtube" : "html5", ...(yt ? { youtubeId: yt } : {}) };
        room.playback = { paused: true, position: 0, playbackRate: 1, updatedAt: now }; break;
      }
      default: throw new Error("Unknown watch command.");
    }
    room.updatedAt = now; this.broadcast(room);
  }
  broadcast(room: Room) {
    const data = `event: state\ndata: ${JSON.stringify(this.snapshot(room))}\n\n`;
    for (const res of [...room.clients]) { if (res.writableEnded || res.destroyed) room.clients.delete(res); else res.write(data); }
  }
  sweep() {
    const now = Date.now();
    for (const [key, room] of this.#rooms) if (room.emptyAt !== null && now - room.emptyAt >= this.#emptyTtlMs && room.clients.size === 0) this.#rooms.delete(key);
  }
  close() { clearInterval(this.#sweep); clearInterval(this.#sync); for (const room of this.#rooms.values()) for (const res of room.clients) res.end(); this.#rooms.clear(); }
}
