/**
 * The contract every text command module implements.
 *
 * To add a command: create `src/discord/commands/<name>.command.ts` whose default export is
 * `defineTextCommand({ ... })`. Nothing else needs editing; the file is discovered at startup.
 * See README.md ("Adding a text command") for a worked example.
 */
import type { AccessPolicy } from "../access/AccessPolicy.ts";
import type { CommandRegistry } from "./commandRegistry.ts";
import type { ImportService } from "../import/ImportService.ts";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { SoundQueue } from "../sound/SoundQueue.ts";
import type { SoundRepository } from "../sound/SoundRepository.ts";
import type { VoiceHub } from "../voice/VoiceHub.ts";
import type { FollowRecorder } from "../recording/FollowRecorder.ts";
import type { StreamManager } from "../streaming/StreamManager.ts";

/** The small slice of a discord.js Message the simple handlers use. */
export interface CommandMessage {
  author: { id: string; tag?: string; username?: string; send(content: string): Promise<unknown> };
  member?: {
    permissions: {
      has(permission: bigint): boolean;
    };
  } | null;
  reply(
    options:
      | string
      | {
          content: string;
          allowedMentions?: { parse: never[] };
        },
  ): Promise<unknown>;
}

/**
 * What commands that play audio or edit their own replies additionally need. Structural, so a
 * discord.js `Message` satisfies it and tests can pass plain fakes.
 */
export interface GuildCommandMessage extends CommandMessage {
  member?: {
    permissions: {
      has(permission: bigint): boolean;
    };
    voice: { channelId: string | null };
  } | null;
  reply(
    options:
      | string
      | {
          content: string;
          allowedMentions?: { parse: never[] };
        },
  ): Promise<{ edit(content: string): Promise<unknown> }>;
  react(emoji: string): Promise<unknown>;
}

/** An incoming message as the dispatcher sees it (a discord.js `Message` fits this shape). */
export interface IncomingMessage extends GuildCommandMessage {
  content: string;
  author: { id: string; bot: boolean; send(content: string): Promise<unknown> };
  guild: { id: string } | null;
}

/** Shared dependencies, built once at startup and handed to every command. */
export interface CommandDeps {
  library: SoundLibrary;
  queue: SoundQueue;
  prefix: string;
  /** Absent when IMPORT_ENABLED=0. */
  importer?: ImportService;
  repo?: SoundRepository;
  /** Who may use the bot and who holds which permission. Decided by user id, never by Discord permissions. */
  access: AccessPolicy;
  voiceHub: VoiceHub;
  /** `!record attach` / `!record detach`: records the voice channel a chosen user is in. */
  followRecorder: FollowRecorder;
  streamManager: StreamManager;
}

/** Everything `execute` receives. Only messages from a guild (server) channel reach a command. */
export interface CommandContext {
  message: GuildCommandMessage;
  guildId: string;
  deps: CommandDeps;
  /** The loaded command registry, set by the dispatcher. Only meta commands such as `!help` need it. */
  registry?: CommandRegistry;
}

/**
 * Help metadata that `!help` / `!commands` renders. The whole block is optional, but a block is only ever
 * shown when it is COMPLETE (`helpProblems` in helpFormat.ts is the one validator behind the startup warning,
 * the owner's diagnostics and what regular users can see). Metadata can never affect loading or behavior.
 *
 * REQUIRED: `summary`; `usages` (at least one), and for every usage `usage`, `summary` and `examples` (at least one).
 * OPTIONAL: `synopsis`, `notes`; per usage `requires` (whose `label` and `check` are then required, `discoverable`
 * optional) and `unavailable`.
 * Strings may use `{p}` where the command prefix goes (`{p}entrance <sound>`).
 */
export interface CommandHelp {
  /** REQUIRED. One line: what the command is for. */
  summary: string;
  /** Optional. How the command is shown in the overview. Default: `{p}<canonical name>`. */
  synopsis?: string;
  /** REQUIRED, at least one. Every way to invoke the command. */
  usages: readonly HelpUsage[];
  /** Optional. Extra remarks, shown on `!help <command>` only when the viewer can run at least one usage. */
  notes?: readonly string[];
}

export interface HelpUsage {
  /** REQUIRED. The syntax, e.g. `{p}entrance @user <sound>`. */
  usage: string;
  /** REQUIRED. What this form does (lowercase, no trailing period reads best). */
  summary: string;
  /** REQUIRED, at least one. */
  examples: readonly string[];
  /** Optional. Set when only some people may run this form; see `HelpRequirement`. */
  requires?: HelpRequirement;
  /** Optional. A short reason when the form cannot work right now (e.g. a disabled feature). Not about permissions. */
  unavailable?: (context: CommandContext) => string | undefined;
}

/**
 * Describes a restriction WITHOUT enforcing it: `check` must call the same predicate the command's own
 * `execute` uses, so `!help` never shows something the command would refuse (or hides something it would accept).
 */
export interface HelpRequirement {
  /** REQUIRED. Shown next to a locked form, e.g. "needs the `import` permission". */
  label: string;
  /** REQUIRED. The command's own permission predicate. */
  check: (context: CommandContext) => boolean;
  /**
   * Optional (default false). What `!help` does for someone who fails `check`: false hides the form completely
   * (for commands that deliberately give strangers no reply); true lists it as locked (summary only, no examples),
   * for commands that already tell people they lack permission. Bot owners always see every form.
   */
  discoverable?: boolean;
}

export interface TextCommand<P> {
  /**
   * Every spelling that triggers this command, lowercase and without the prefix. The first entry is
   * the canonical name; the rest are aliases (e.g. `["entrance", "rm-entrance"]`). Matching ignores
   * the case the user typed. Names must be unique across ALL command modules.
   */
  names: readonly [string, ...string[]];
  /** One line, used in startup logs and errors. */
  description: string;
  /** Optional documentation for `!help`. Missing or malformed help never affects loading or behavior. */
  help?: CommandHelp;
  /**
   * Decides whether `content` is this command and extracts its arguments. Return `null` when the
   * message is not for this command (the bot then stays silent). Called only for messages whose
   * first word is one of `names`.
   */
  parse(content: string, prefix: string): P | null;
  /** Runs the command. Errors thrown here are logged by the dispatcher; the bot keeps running. */
  execute(context: CommandContext, parsed: P): Promise<void>;
}

/** Identity helper: gives a command module full type checking and infers `P` from `parse`. */
export function defineTextCommand<P>(command: TextCommand<P>): TextCommand<P> {
  return command;
}
