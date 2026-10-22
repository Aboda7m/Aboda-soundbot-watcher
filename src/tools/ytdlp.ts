/**
 * Locates and checks the portable yt-dlp binary that lives inside the project (tools/yt-dlp/bin).
 * Paths are derived from this file's location, never from the current working directory, so the bot finds the
 * executable no matter where it is started from. Nothing here downloads or runs yt-dlp for real work yet:
 * it only answers "is it there, does it run, which version is it".
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, constants, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** <project>/tools/yt-dlp/ (this file is <project>/src/tools/ytdlp.ts) */
export const YTDLP_DIR = fileURLToPath(new URL("../../tools/yt-dlp/", import.meta.url));
export const MANIFEST_PATH = join(YTDLP_DIR, "manifest.json");

export interface ManifestAsset {
  /** file name of the release asset on GitHub */
  file: string;
  /** lowercase hex SHA-256 of that file, or null until it has been verified once */
  sha256: string | null;
}
export interface Manifest {
  version: string;
  repository: string;
  assets: Record<string, ManifestAsset>;
}

/** e.g. "win32-x64", "linux-arm64" */
export const platformKey = (platform: string = process.platform, arch: string = process.arch): string => `${platform}-${arch}`;

/** Name of the binary inside tools/yt-dlp/bin. Always the same on a platform, whatever the release asset is called. */
export const localBinaryName = (platform: string = process.platform): string => (platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

export const defaultYtDlpPath = (platform: string = process.platform): string => join(YTDLP_DIR, "bin", localBinaryName(platform));

export function readManifest(path: string = MANIFEST_PATH): Manifest {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read the yt-dlp manifest at ${path}: ${(err as Error).message}`);
  }
  const m = data as Partial<Manifest>;
  if (typeof m.version !== "string" || typeof m.repository !== "string" || typeof m.assets !== "object" || m.assets === null)
    throw new Error(`The yt-dlp manifest at ${path} is malformed (needs version, repository and assets).`);
  return m as Manifest;
}

export interface YtDlpStatus {
  available: boolean;
  path: string;
  /** what `yt-dlp --version` printed */
  version?: string;
  /** pinned version from the manifest; only compared when the bundled binary is used */
  expectedVersion?: string;
  versionMatches?: boolean;
  /** human-readable explanation when not available, or a warning when the version differs */
  problem?: string;
}

export interface CheckOptions {
  /** executable to check; defaults to the bundled one */
  path?: string;
  expectedVersion?: string;
  timeoutMs?: number;
  /** injectable for tests */
  runVersion?(path: string, timeoutMs: number): Promise<string>;
}

function execVersion(path: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, ["--version"], { timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr })) : resolve(stdout),
    );
  });
}

const INSTALL_HINT = 'Run "npm run ytdlp:install" in the bot folder.';

/** Never throws: returns what is wrong in `problem`. */
export async function checkYtDlp(opts: CheckOptions = {}): Promise<YtDlpStatus> {
  const path = opts.path ?? defaultYtDlpPath();
  const bundled = path === defaultYtDlpPath();
  let expectedVersion = opts.expectedVersion;
  if (expectedVersion === undefined && bundled) {
    try {
      expectedVersion = readManifest().version;
    } catch {
      // a missing manifest must not hide whether the binary itself works
    }
  }

  try {
    if (!(await stat(path)).isFile()) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      available: false,
      path,
      expectedVersion,
      problem:
        code === "ENOENT" || code === "ENOTDIR"
          ? `yt-dlp was not found at ${path}. ${bundled ? INSTALL_HINT : "Check YTDLP_PATH."}`
          : `yt-dlp at ${path} is not a usable file (${(err as Error).message}).`,
    };
  }
  if (process.platform !== "win32") {
    try {
      await access(path, constants.X_OK);
    } catch {
      return { available: false, path, expectedVersion, problem: `yt-dlp at ${path} is not executable. ${bundled ? INSTALL_HINT : "Run chmod +x on it."}` };
    }
  }

  let version: string;
  try {
    version = (await (opts.runVersion ?? execVersion)(path, opts.timeoutMs ?? 30_000)).trim();
  } catch (err) {
    const e = err as { killed?: boolean; stderr?: string; message: string };
    const detail = e.killed ? "it did not answer within the time limit" : (e.stderr?.trim() || e.message).split("\n")[0];
    return {
      available: false,
      path,
      expectedVersion,
      problem: `yt-dlp at ${path} did not run: ${detail}. On Windows this can also mean the Microsoft Visual C++ Redistributable is missing, or antivirus blocked the file.`,
    };
  }
  if (!version) return { available: false, path, expectedVersion, problem: `yt-dlp at ${path} ran but printed no version.` };

  const versionMatches = expectedVersion === undefined || !bundled ? undefined : version === expectedVersion;
  return {
    available: true,
    path,
    version,
    expectedVersion,
    versionMatches,
    problem:
      versionMatches === false
        ? `yt-dlp is ${version} but this project pins ${expectedVersion}. Run "npm run ytdlp:install" to get the pinned version (or "npm run ytdlp:update -- <version>" to change the pin).`
        : undefined,
  };
}
