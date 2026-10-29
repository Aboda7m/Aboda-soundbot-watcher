import type { SoundRepository } from "../../sound/SoundRepository.ts";
import { defineTextCommand, type CommandMessage } from "../commandTypes.ts";
import { say } from "../commandUtils.ts";

type PolicyAction =
  | { kind: "show" }
  | { kind: "enabled"; value: boolean }
  | { kind: "reconnect"; seconds: number }
  | { kind: "cooldown"; seconds: number }
  | { kind: "cap"; seconds: number | null };

function parseDuration(input: string, maxSeconds = 86400): number | null {
  const value = input.trim().toLowerCase();
  if (["off", "none", "disabled"].includes(value)) return 0;
  const match = /^(\d+)(s|sec|secs|m|min|mins|h|hr|hrs)?$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = ["m", "min", "mins"].includes(unit) ? 60 : ["h", "hr", "hrs"].includes(unit) ? 3600 : 1;
  const seconds = amount * multiplier;
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= maxSeconds ? seconds : null;
}

export function parseEntrancePolicyCommand(content: string, prefix = "!"): PolicyAction | null {
  const text = content.trim();
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const command = text.slice(prefix.length);
  const match = /^entrance-policy(?:\s+(.*))?$/i.exec(command);
  if (!match) return null;
  const args = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
  if (!args.length || ["show", "status"].includes(args[0]!.toLowerCase())) return args.length <= 1 ? { kind: "show" } : null;
  const [setting, rawValue, extra] = args;
  if (!rawValue || extra) return null;
  const key = setting!.toLowerCase();
  if (["enabled", "enable", "disable"].includes(key)) {
    const value = key === "enable" ? "on" : key === "disable" ? "off" : rawValue.toLowerCase();
    if (["on", "true", "yes"].includes(value)) return { kind: "enabled", value: true };
    if (["off", "false", "no"].includes(value)) return { kind: "enabled", value: false };
    return null;
  }
  if (["reconnect", "grace"].includes(key)) {
    const seconds = parseDuration(rawValue);
    return seconds === null ? null : { kind: "reconnect", seconds };
  }
  if (["cooldown"].includes(key)) {
    const seconds = parseDuration(rawValue);
    return seconds === null ? null : { kind: "cooldown", seconds };
  }
  if (["cap", "duration"].includes(key)) {
    if (["off", "none", "disabled"].includes(rawValue.toLowerCase())) return { kind: "cap", seconds: null };
    const seconds = parseDuration(rawValue, 30);
    return seconds === null || seconds < 1 ? null : { kind: "cap", seconds };
  }
  return null;
}

const isGuildPolicyAdmin = (message: CommandMessage, access: { can(userId: string, capability: "entrance.manage"): boolean }): boolean =>
  Boolean(message.member?.permissions.has(8n) ||
    message.member?.permissions.has(32n) ||
    access.can(message.author.id, "entrance.manage"));

function formatDuration(seconds: number | null | undefined, fallback: string): string {
  if (seconds === undefined) return `${fallback} (default)`;
  if (seconds === null) return "no limit";
  if (seconds === 0) return "off";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export async function handleEntrancePolicy(
  message: CommandMessage,
  guildId: string,
  action: PolicyAction,
  deps: { repo?: SoundRepository; prefix: string; access: { can(userId: string, capability: "entrance.manage"): boolean } },
): Promise<void> {
  const { repo, prefix, access } = deps;
  if (!repo) { await say(message, "Entrance policy settings are unavailable right now."); return; }
  if (!isGuildPolicyAdmin(message, access)) {
    await say(message, "Only this server's owner/admin or a bot user with entrance.manage can change the entrance policy.");
    return;
  }

  if (action.kind === "show") {
    const policy = repo.guildEntranceSettings(guildId);
    await say(message,
      `**Entrance policy for this server**\n` +
      `Automatic entrances: **${policy.enabled === false ? "disabled" : "enabled"}**\n` +
      `Reconnect grace: **${formatDuration(policy.reconnectGraceSec, "5m")}**\n` +
      `Entrance cooldown: **${formatDuration(policy.enforcedUserCooldownSec ?? policy.userCooldownSec, "off")}**\n` +
      `Automatic entrance duration cap: **${formatDuration(policy.maxDurationSec, "none")}**\n\n` +
      `Commands: \`${prefix}entrance-policy enabled on|off\`, \`${prefix}entrance-policy reconnect 5m|15m|off\`, ` +
      `\`${prefix}entrance-policy cooldown off|5m\`, \`${prefix}entrance-policy cap off|1-30\`.`);
    return;
  }

  if (action.kind === "enabled") {
    repo.setGuildEntranceSettings(guildId, { enabled: action.value });
    await say(message, `Automatic entrance sounds are now **${action.value ? "enabled" : "disabled"}** for this server.`);
    return;
  }
  if (action.kind === "reconnect") {
    repo.setGuildEntranceSettings(guildId, { reconnectGraceSec: action.seconds, minReconnectGraceSec: action.seconds });
    await say(message, `Reconnect grace is now **${formatDuration(action.seconds, "5m")}** for this server (minimum enforced).`);
    return;
  }
  if (action.kind === "cooldown") {
    repo.setGuildEntranceSettings(guildId, {
      allowUserCooldown: false,
      userCooldownSec: action.seconds,
      enforcedUserCooldownSec: action.seconds,
    });
    await say(message, `Server entrance cooldown is now **${formatDuration(action.seconds, "off")}**. This setting overrides member cooldown preferences without changing their reconnect grace preferences.`);
    return;
  }
  if (action.kind === "cap") {
    repo.setGuildEntranceSettings(guildId, { maxDurationSec: action.seconds });
    await say(message, action.seconds === null
      ? "The server's automatic entrance duration cap has been removed."
      : `Automatic entrance sounds are now capped at **${action.seconds} seconds** in this server.`);
  }
}

export default defineTextCommand({
  names: ["entrance-policy"],
  description: "Show or configure this server's automatic entrance policy",
  parse: parseEntrancePolicyCommand,
  execute: async ({ message, guildId, deps }, action) => {
    await handleEntrancePolicy(message, guildId, action, { repo: deps.repo, prefix: deps.prefix, access: deps.access });
  },
});
