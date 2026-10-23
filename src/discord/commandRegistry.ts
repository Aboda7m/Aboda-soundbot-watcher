/**
 * Startup discovery of text commands.
 *
 * `loadCommands()` imports every `*.command.ts` file in `./commands/`, checks that its default export
 * is a well-formed `TextCommand`, and builds a lookup table keyed by every name/alias. Any problem
 * (unreadable folder, import error, malformed module, duplicate name, stray source file) makes it
 * throw one `CommandLoadError` listing ALL problems, so the bot never starts half-configured.
 *
 * Discovery happens once at startup; there is no hot reload. The node runtime used by this project
 * executes `.ts` directly (no build step), so the files are imported as-is.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TextCommand } from "./commandTypes.ts";

/** Only files with this suffix are loaded as commands. */
export const COMMAND_FILE_SUFFIX = ".command.ts";

/** Lowercase letters, digits, `-` and `_`; must start with a letter or digit. No spaces, no prefix. */
export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Source-looking files that do NOT end in `.command.ts` are reported instead of silently ignored. */
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

const DEFAULT_COMMANDS_DIR = new URL("./commands/", import.meta.url);

export class CommandLoadError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Could not load text commands:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CommandLoadError";
    this.problems = problems;
  }
}

export interface RegisteredCommand {
  /** File name inside the commands folder, e.g. `sound.command.ts`. */
  file: string;
  command: TextCommand<unknown>;
}

export interface CommandRegistry {
  /** Sorted by canonical name (plain code-unit order), independent of directory listing order. */
  readonly commands: readonly RegisteredCommand[];
  /** Finds a command by canonical name or alias (lowercase, without prefix). */
  lookup(name: string): RegisteredCommand | undefined;
}

export interface CommandEntry {
  file: string;
  /** The module's default export, unchecked. */
  value: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Returns every reason `value` is not a usable `TextCommand` (empty when it is fine). */
export function validateCommand(value: unknown): string[] {
  if (!isPlainObject(value)) return [`default export must be an object created with defineTextCommand(...), got ${value === null ? "null" : typeof value}`];

  const problems: string[] = [];
  const { names, description, parse, execute } = value;

  if (!Array.isArray(names) || names.length === 0) {
    problems.push("`names` must be a non-empty array of strings");
  } else {
    const seen = new Set<string>();
    for (const n of names) {
      if (typeof n !== "string" || !COMMAND_NAME_PATTERN.test(n)) {
        problems.push(`invalid name ${JSON.stringify(n)}: use lowercase letters, digits, "-" or "_" (no prefix, no spaces)`);
      } else if (seen.has(n)) {
        problems.push(`name "${n}" is listed twice`);
      } else {
        seen.add(n);
      }
    }
  }
  if (typeof description !== "string" || description.trim() === "") problems.push("`description` must be a non-empty string");
  if (typeof parse !== "function") problems.push("`parse` must be a function");
  if (typeof execute !== "function") problems.push("`execute` must be a function");
  return problems;
}

/**
 * Validates already-imported modules and builds the registry. `priorProblems` (e.g. import failures
 * found while scanning) are reported together with the problems found here.
 */
export function createRegistry(entries: readonly CommandEntry[], priorProblems: readonly string[] = []): CommandRegistry {
  const problems = [...priorProblems];
  const registered: RegisteredCommand[] = [];
  const owner = new Map<string, string>(); // name -> file

  for (const { file, value } of [...entries].sort((a, b) => byCodeUnit(a.file, b.file))) {
    const bad = validateCommand(value);
    if (bad.length > 0) {
      for (const p of bad) problems.push(`${file}: ${p}`);
      continue;
    }
    const command = value as TextCommand<unknown>; // shape verified by validateCommand above
    let clash = false;
    for (const name of command.names) {
      const other = owner.get(name);
      if (other !== undefined) {
        problems.push(`duplicate command name "${name}" in ${other} and ${file}`);
        clash = true;
      }
    }
    if (clash) continue;
    for (const name of command.names) owner.set(name, file);
    registered.push({ file, command });
  }

  if (registered.length === 0 && problems.length === 0) problems.push("no command modules found");
  if (problems.length > 0) throw new CommandLoadError(problems);

  registered.sort((a, b) => byCodeUnit(a.command.names[0], b.command.names[0]));
  const byName = new Map<string, RegisteredCommand>();
  for (const entry of registered) for (const name of entry.command.names) byName.set(name, entry);

  return { commands: registered, lookup: (name) => byName.get(name) };
}

/**
 * Imports every `*.command.ts` in `dir` (default: `./commands/` next to this file) and returns the
 * registry. Throws `CommandLoadError` if anything is wrong.
 */
export async function loadCommands(dir: URL = DEFAULT_COMMANDS_DIR): Promise<CommandRegistry> {
  const dirPath = fileURLToPath(dir);

  let dirents;
  try {
    dirents = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    throw new CommandLoadError([`cannot read commands folder ${dirPath}: ${errorText(err)}`]);
  }

  const problems: string[] = [];
  const entries: CommandEntry[] = [];

  for (const dirent of [...dirents].sort((a, b) => byCodeUnit(a.name, b.name))) {
    const { name } = dirent;
    if (name.startsWith(".")) continue;
    if (dirent.isDirectory()) {
      problems.push(`${name}/: subfolders are not scanned; put command files directly in the commands folder`);
      continue;
    }
    if (!name.endsWith(COMMAND_FILE_SUFFIX)) {
      if (SOURCE_FILE.test(name)) problems.push(`${name}: not loaded as a command; file names must end in ${COMMAND_FILE_SUFFIX}`);
      continue;
    }
    try {
      const mod = await import(pathToFileURL(join(dirPath, name)).href);
      if (mod.default === undefined) problems.push(`${name}: has no default export (use \`export default defineTextCommand({...})\`)`);
      else entries.push({ file: name, value: mod.default });
    } catch (err) {
      problems.push(`${name}: failed to import: ${errorText(err)}`);
    }
  }

  return createRegistry(entries, problems);
}

/** One line for the startup log, e.g. `entrance (+rm-entrance), import, sound, soundlist`. */
export function describeRegistry(registry: CommandRegistry): string {
  return registry.commands
    .map(({ command }) => {
      const [name, ...aliases] = command.names;
      return aliases.length ? `${name} (+${aliases.join(", +")})` : name;
    })
    .join(", ");
}
