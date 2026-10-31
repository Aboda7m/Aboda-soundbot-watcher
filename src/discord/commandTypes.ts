/**
 * The contract every text command module implements.
 *
 * To add a command: create `src/discord/commands/<name>.command.ts` whose default export is
 * `defineTextCommand({ ... })`. Nothing else needs editing; the file is discovered at startup.
 * See README.md ("Adding a text command") for a worked example.
 */
import type { AccessPolicy } from "../access/AccessPolicy.ts";
import type { ImportService } from "../import/ImportService.ts";
import type { SoundLibrary } from "../sound/SoundLibrary.ts";
import type { SoundQueue } from "../sound/SoundQueue.ts";
import type { SoundRepository } from "../sound/SoundRepository.ts";
import type { VoiceHub } from "../voice/VoiceHub.ts";

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
}

/** Everything `execute` receives. Only messages from a guild (server) channel reach a command. */
export interface CommandContext {
  message: GuildCommandMessage;
  guildId: string;
  deps: CommandDeps;
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
