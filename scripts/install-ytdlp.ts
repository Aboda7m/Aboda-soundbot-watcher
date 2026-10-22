/**
 * Installs the pinned yt-dlp release into tools/yt-dlp/bin.
 *
 *   npm run ytdlp:install                  download the version in tools/yt-dlp/manifest.json (skips if already installed)
 *   npm run ytdlp:install -- --force       reinstall even if the right version is present
 *   npm run ytdlp:check                    report where yt-dlp is and which version runs
 *   npm run ytdlp:update -- 2026.10.21     change the pin (fetches the release checksums); then run ytdlp:install
 *
 * Nothing here runs automatically: no postinstall hook, and the installed binary never updates itself in place.
 * Every download is checked against a SHA-256: the one pinned in the manifest if there is one, otherwise the
 * SHA2-256SUMS file GitHub publishes for that exact release (and the verified hash is then written into the manifest).
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { checkYtDlp, defaultYtDlpPath, localBinaryName, MANIFEST_PATH, platformKey, readManifest, type Manifest } from "../src/tools/ytdlp.ts";

const MAX_BYTES = 300 * 1024 * 1024; // yt-dlp.exe is ~20 MB; this only stops a runaway download
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const STABLE_VERSION = /^\d{4}\.\d{2}\.\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface InstallOptions {
  manifestPath?: string;
  /** folder that receives the binary (default tools/yt-dlp/bin) */
  binDir?: string;
  platformKey?: string;
  /** default https://github.com; tests point this at a local server */
  baseUrl?: string;
  force?: boolean;
  /** write a newly verified hash back into the manifest (default true) */
  lock?: boolean;
  fetchImpl?: typeof fetch;
  /** injectable for tests; default runs `<binary> --version` */
  runVersion?(path: string, timeoutMs: number): Promise<string>;
  log?(message: string): void;
}

export interface InstallResult {
  status: "installed" | "already-installed";
  path: string;
  version: string;
  sha256: string;
}

/** Parses GNU-style checksum files ("<hash>  <file>" or "<hash> *<file>"). */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

const releaseUrl = (base: string, repo: string, version: string, file: string) => `${base}/${repo}/releases/download/${version}/${file}`;

async function get(fetchImpl: typeof fetch, url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${(err as Error).message}. Check your internet connection or proxy.`);
  }
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `Not found (404): ${url}. That release or file does not exist; check the version in tools/yt-dlp/manifest.json.`
        : `Download failed (HTTP ${res.status}) for ${url}.`,
    );
  }
  return res;
}

async function sha256OfFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeManifest(path: string, m: Manifest): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(m, null, 2) + "\n");
  await rename(tmp, path);
}

export async function installYtDlp(opts: InstallOptions = {}): Promise<InstallResult> {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const manifestPath = opts.manifestPath ?? MANIFEST_PATH;
  const manifest = readManifest(manifestPath);
  const key = opts.platformKey ?? platformKey();
  const asset = manifest.assets[key];
  if (!asset)
    throw new Error(`No yt-dlp build is listed for ${key}. Supported: ${Object.keys(manifest.assets).join(", ")}. You can set YTDLP_PATH to your own yt-dlp instead.`);

  const dest = opts.binDir ? join(opts.binDir, localBinaryName(key.split("-")[0])) : defaultYtDlpPath(key.split("-")[0]);
  const check = (path: string) => checkYtDlp({ path, expectedVersion: manifest.version, runVersion: opts.runVersion });
  const base = opts.baseUrl ?? "https://github.com";

  // Already there? Only skip when it is the pinned version and (if a hash is pinned) the bytes match.
  if (!opts.force) {
    const exists = await stat(dest).then((s) => s.isFile(), () => false);
    if (exists) {
      const st = await checkYtDlp({ path: dest, runVersion: opts.runVersion });
      const hash = await sha256OfFile(dest);
      if (st.available && st.version === manifest.version && (!asset.sha256 || asset.sha256 === hash)) {
        log(`yt-dlp ${manifest.version} is already installed at ${dest}`);
        return { status: "already-installed", path: dest, version: manifest.version, sha256: hash };
      }
      log(`Replacing the existing file (${st.available ? `version ${st.version}` : "not working"}).`);
    }
  }

  // Which hash must the download have?
  let expected = asset.sha256;
  let fromSums = false;
  if (expected !== null && !SHA256.test(expected)) throw new Error(`The sha256 for ${key} in the manifest is not a 64-character hex string.`);
  if (expected === null) {
    const sumsUrl = releaseUrl(base, manifest.repository, manifest.version, "SHA2-256SUMS");
    log(`No pinned hash for ${key}; reading the release checksums: ${sumsUrl}`);
    const sums = parseSums(await (await get(fetchImpl, sumsUrl)).text());
    expected = sums.get(asset.file) ?? null;
    if (!expected) throw new Error(`The release's SHA2-256SUMS has no entry for ${asset.file}, so the download cannot be verified.`);
    fromSums = true;
  }

  // Download to a temp file next to the destination while hashing; only a verified file is moved into place.
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.download`;
  const url = releaseUrl(base, manifest.repository, manifest.version, asset.file);
  log(`Downloading ${url}`);
  const res = await get(fetchImpl, url);
  if (!res.body) throw new Error(`Empty response from ${url}.`);
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(res.body as never),
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > MAX_BYTES) return cb(new Error(`Download is larger than ${MAX_BYTES / 1024 / 1024} MB, stopping.`));
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      createWriteStream(part, { mode: 0o755 }),
    );
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  const actual = hash.digest("hex");
  if (actual !== expected) {
    await rm(part, { force: true });
    throw new Error(`Checksum mismatch for ${asset.file}: expected ${expected}, got ${actual}. The file was discarded and nothing was installed.`);
  }

  if (!key.startsWith("win32")) await chmod(part, 0o755);
  try {
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw new Error(`Could not put yt-dlp in place at ${dest}: ${(err as Error).message}. If the bot or another yt-dlp is running, stop it and retry.`);
  }

  const st = await check(dest);
  if (!st.available || st.version !== manifest.version) {
    await rm(dest, { force: true });
    throw new Error(st.available ? `Installed file reports version ${st.version}, expected ${manifest.version}. It was removed.` : `${st.problem} The file was removed.`);
  }

  if (fromSums && (opts.lock ?? true)) {
    asset.sha256 = actual;
    await writeManifest(manifestPath, manifest);
    log(`Pinned the verified SHA-256 for ${key} in ${manifestPath}. Commit this file to keep installs repeatable.`);
  }
  log(`Installed yt-dlp ${st.version} at ${dest}`);
  return { status: "installed", path: dest, version: st.version, sha256: actual };
}

/** Changes the pinned version and fills in the hashes of every platform from that release's SHA2-256SUMS. Does not download binaries. */
export async function updateManifest(version: string, opts: { manifestPath?: string; baseUrl?: string; fetchImpl?: typeof fetch; log?(m: string): void } = {}): Promise<Manifest> {
  const log = opts.log ?? (() => {});
  if (!STABLE_VERSION.test(version)) throw new Error(`"${version}" is not a stable yt-dlp release (expected something like 2026.10.21). Nightly/master builds are not supported here.`);
  const manifestPath = opts.manifestPath ?? MANIFEST_PATH;
  const manifest = readManifest(manifestPath);
  const sumsUrl = releaseUrl(opts.baseUrl ?? "https://github.com", manifest.repository, version, "SHA2-256SUMS");
  log(`Reading ${sumsUrl}`);
  const sums = parseSums(await (await get(opts.fetchImpl ?? fetch, sumsUrl)).text());
  let pinned = 0;
  for (const [key, asset] of Object.entries(manifest.assets)) {
    const h = sums.get(asset.file);
    asset.sha256 = h ?? null;
    if (h) pinned++;
    else log(`Warning: release ${version} has no ${asset.file} (${key}); it stays unpinned.`);
  }
  if (!pinned) throw new Error(`Release ${version} lists none of the expected files; the manifest was not changed.`);
  manifest.version = version;
  await writeManifest(manifestPath, manifest);
  log(`Pinned yt-dlp ${version} (${pinned} platform hashes). Now run: npm run ytdlp:install`);
  return manifest;
}

// ------------------------------------------------------------------------------------ CLI

async function main(argv: string[]): Promise<number> {
  const [cmd = "install", ...rest] = argv;
  const log = (m: string) => console.log(m);
  try {
    if (cmd === "install") {
      await installYtDlp({ force: rest.includes("--force"), log });
      return 0;
    }
    if (cmd === "update") {
      const version = rest.find((a) => !a.startsWith("-"));
      if (!version) throw new Error("Usage: npm run ytdlp:update -- <version>   e.g. 2026.10.21");
      await updateManifest(version, { log });
      return 0;
    }
    if (cmd === "check") {
      const { loadConfig } = await import("../src/config.ts");
      const path = loadConfig().ytdlpPath;
      const st = await checkYtDlp({ path });
      console.log(`Path:     ${st.path}`);
      console.log(`Pinned:   ${st.expectedVersion ?? "(none, custom YTDLP_PATH)"}`);
      console.log(`Version:  ${st.version ?? "not available"}`);
      if (st.problem) console.log(`${st.available ? "Warning" : "Problem"}:  ${st.problem}`);
      else console.log("OK");
      return st.available ? 0 : 1;
    }
    throw new Error(`Unknown command "${cmd}". Use install, check or update.`);
  } catch (err) {
    console.error(`yt-dlp: ${(err as Error).message}`);
    return 1;
  }
}

const same = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
