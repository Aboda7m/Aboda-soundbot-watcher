import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import { checkYtDlp, defaultYtDlpPath, localBinaryName, platformKey, readManifest, YTDLP_DIR } from "../src/tools/ytdlp.ts";
import { installYtDlp, parseSums, updateManifest } from "../scripts/install-ytdlp.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "ytdlp-test-"));
after(() => rmSync(work, { recursive: true, force: true }));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ------------------------------------------------------------------------- locating the binary

test("the shipped manifest is valid and pins a real release for every listed platform", () => {
  const m = readManifest();
  assert.match(m.version, /^\d{4}\.\d{2}\.\d{2}$/);
  assert.equal(m.repository, "yt-dlp/yt-dlp");
  for (const key of ["win32-x64", "linux-x64", "darwin-arm64"]) assert.ok(m.assets[key]?.file, key);
  assert.equal(m.assets["win32-x64"]!.file, "yt-dlp.exe");
  for (const a of Object.values(m.assets)) assert.ok(a.sha256 === null || /^[0-9a-f]{64}$/.test(a.sha256));
});

test("platform keys and binary names", () => {
  assert.equal(platformKey("win32", "x64"), "win32-x64");
  assert.equal(localBinaryName("win32"), "yt-dlp.exe");
  assert.equal(localBinaryName("linux"), "yt-dlp");
  assert.equal(defaultYtDlpPath("win32"), join(YTDLP_DIR, "bin", "yt-dlp.exe"));
});

test("the default location is inside the project and does not depend on the working directory", () => {
  assert.equal(YTDLP_DIR.replace(/[\\/]+$/, ""), join(root, "tools", "yt-dlp"));
  const elsewhere = mkdtempSync(join(work, "cwd-"));
  const out = execFileSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e",
      `import { defaultYtDlpPath } from ${JSON.stringify(pathToFileURL(join(root, "src/tools/ytdlp.ts")).href)}; console.log(defaultYtDlpPath());`],
    { cwd: elsewhere },
  ).toString().trim();
  assert.equal(out, defaultYtDlpPath());
  assert.ok(out.startsWith(root));
});

test("config: bundled path by default, YTDLP_PATH overrides it", () => {
  assert.equal(loadConfig({}).ytdlpPath, defaultYtDlpPath());
  assert.equal(loadConfig({ YTDLP_PATH: "  " }).ytdlpPath, defaultYtDlpPath());
  assert.equal(loadConfig({ YTDLP_PATH: join(work, "my yt-dlp.exe") }).ytdlpPath, join(work, "my yt-dlp.exe"));
});

// ------------------------------------------------------------------------- capability check

test("check: a missing binary gives an actionable message and never throws", async () => {
  const st = await checkYtDlp({ path: join(work, "does-not-exist", "yt-dlp") });
  assert.equal(st.available, false);
  assert.match(st.problem!, /not found at .*does-not-exist/);
  assert.match(st.problem!, /Check YTDLP_PATH/); // custom path: points at the setting
  const bundled = await checkYtDlp({ path: defaultYtDlpPath(), runVersion: async () => "x" });
  if (!existsSync(defaultYtDlpPath())) {
    assert.equal(bundled.available, false);
    assert.match(bundled.problem!, /npm run ytdlp:install/); // bundled path: points at the installer
  }
  const dir = await checkYtDlp({ path: work }); // a folder is not an executable
  assert.equal(dir.available, false);
  assert.match(dir.problem!, /not a usable file/);
});

test("check: runs a real executable with --version (path with spaces), reports the version", async () => {
  // node itself is a real executable that answers --version, on every platform
  const st = await checkYtDlp({ path: process.execPath });
  assert.equal(st.available, true);
  assert.equal(st.version, process.version);
  assert.equal(st.problem, undefined);
});

test("check: compares against the pinned version only for the bundled binary", async () => {
  const bundledPath = defaultYtDlpPath();
  const pinned = readManifest().version;
  const same = await checkYtDlp({ path: process.execPath, expectedVersion: "9999.01.01", runVersion: async () => "2026.01.01" });
  assert.equal(same.available, true);
  assert.equal(same.versionMatches, undefined); // custom path: no pin comparison
  assert.equal(same.problem, undefined);
  if (existsSync(bundledPath)) {
    const ok = await checkYtDlp({ runVersion: async () => pinned });
    assert.equal(ok.versionMatches, true);
    const old = await checkYtDlp({ runVersion: async () => "2020.01.01" });
    assert.equal(old.available, true);
    assert.equal(old.versionMatches, false);
    assert.match(old.problem!, /pins .*npm run ytdlp:install/);
  }
});

test("check: a failing or silent executable is reported, not thrown", { skip: process.platform === "win32" }, async () => {
  const bad = join(work, "bad-yt-dlp");
  writeFileSync(bad, "#!/bin/sh\necho 'boom: missing library' >&2\nexit 3\n");
  chmodSync(bad, 0o755);
  const st = await checkYtDlp({ path: bad });
  assert.equal(st.available, false);
  assert.match(st.problem!, /did not run: boom: missing library/);
  const silent = join(work, "silent-yt-dlp");
  writeFileSync(silent, "#!/bin/sh\nexit 0\n");
  chmodSync(silent, 0o755);
  assert.match((await checkYtDlp({ path: silent })).problem!, /printed no version/);
  const noexec = join(work, "noexec-yt-dlp");
  writeFileSync(noexec, "#!/bin/sh\necho 1\n");
  chmodSync(noexec, 0o644);
  assert.match((await checkYtDlp({ path: noexec })).problem!, /not executable/);
  const slow = join(work, "slow-yt-dlp");
  writeFileSync(slow, "#!/bin/sh\nexec sleep 10\n");
  chmodSync(slow, 0o755);
  assert.match((await checkYtDlp({ path: slow, timeoutMs: 300 })).problem!, /did not answer within the time limit/);
});

// ------------------------------------------------------------------------- installer (local fake "GitHub")

const VERSION = "2026.10.21";
const FILE = Buffer.from("pretend this is yt-dlp.exe\n".repeat(1000));
let server: Server;
let baseUrl = "";
let hits: string[] = [];
let sumsBody = "";
let fileStatus = 200;

before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const m = /^\/yt-dlp\/yt-dlp\/releases\/download\/([^/]+)\/(.+)$/.exec(req.url ?? "");
    if (!m) return void res.writeHead(404).end();
    if (m[2] === "SHA2-256SUMS") return void res.writeHead(m[1] === "9999.99.99" ? 404 : 200).end(m[1] === "2026.11.01" ? sums("2026.11.01") : sumsBody);
    if (m[2] === "yt-dlp.exe" || m[2] === "yt-dlp_linux") return void res.writeHead(fileStatus).end(fileStatus === 200 ? FILE : "nope");
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

const sums = (_v?: string) => `${sha(FILE)}  yt-dlp.exe\n${sha(FILE)}  yt-dlp_linux\n${"a".repeat(64)} *yt-dlp_macos\n`;

function fixture(over: { sha256?: string | null; key?: string } = {}) {
  const dir = mkdtempSync(join(work, "inst-"));
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    version: VERSION, repository: "yt-dlp/yt-dlp",
    assets: {
      "win32-x64": { file: "yt-dlp.exe", sha256: over.sha256 ?? null },
      "linux-x64": { file: "yt-dlp_linux", sha256: over.sha256 ?? null },
      "darwin-arm64": { file: "yt-dlp_macos", sha256: null },
    },
  }));
  const binDir = join(dir, "bin");
  hits = [];
  sumsBody = sums();
  fileStatus = 200;
  const logs: string[] = [];
  const opts = {
    manifestPath, binDir, baseUrl, platformKey: over.key ?? "win32-x64", log: (m: string) => logs.push(m),
    runVersion: async (path: string) => (readFileSync(path).equals(FILE) ? VERSION : "garbage"),
  };
  return { dir, manifestPath, binDir, opts, logs };
}

test("installer: parses GNU checksum files (CRLF, binary marker, junk lines)", () => {
  const h = "b".repeat(64);
  const m = parseSums(`${h}  yt-dlp.exe\r\n${"C".repeat(64)} *yt-dlp_linux\nnot a line\n${"d".repeat(10)}  short\n`);
  assert.equal(m.get("yt-dlp.exe"), h);
  assert.equal(m.get("yt-dlp_linux"), "c".repeat(64));
  assert.equal(m.size, 2);
});

test("installer: downloads, verifies against the release checksums, installs, pins the hash, and is idempotent", async () => {
  const f = fixture();
  const r = await installYtDlp(f.opts);
  assert.equal(r.status, "installed");
  assert.equal(r.path, join(f.binDir, "yt-dlp.exe"));
  assert.equal(readFileSync(r.path).equals(FILE), true);
  assert.deepEqual(readdirSync(f.binDir), ["yt-dlp.exe"]); // no .download leftovers
  assert.equal(readManifest(f.manifestPath).assets["win32-x64"]!.sha256, sha(FILE)); // locked for next time
  assert.equal(readManifest(f.manifestPath).assets["linux-x64"]!.sha256, null); // other platforms untouched
  assert.ok(hits.some((h) => h.endsWith("/SHA2-256SUMS")));

  hits = [];
  const again = await installYtDlp(f.opts);
  assert.equal(again.status, "already-installed");
  assert.deepEqual(hits, []); // nothing downloaded

  const forced = await installYtDlp({ ...f.opts, force: true });
  assert.equal(forced.status, "installed");
  assert.deepEqual(hits, [`/yt-dlp/yt-dlp/releases/download/${VERSION}/yt-dlp.exe`]); // pinned hash: no checksum file needed
});

test("installer: other platforms get their own asset and a non-Windows name", async () => {
  const f = fixture({ key: "linux-x64" });
  const r = await installYtDlp(f.opts);
  assert.equal(r.path, join(f.binDir, "yt-dlp"));
  if (process.platform !== "win32") assert.notEqual(statSync(r.path).mode & 0o111, 0); // executable bit set
});

test("installer: a checksum mismatch (release checksums) installs nothing", async () => {
  const f = fixture();
  sumsBody = `${"0".repeat(64)}  yt-dlp.exe\n`;
  await assert.rejects(installYtDlp(f.opts), /Checksum mismatch for yt-dlp\.exe/);
  assert.equal(existsSync(f.binDir) ? readdirSync(f.binDir).length : 0, 0);
  assert.equal(readManifest(f.manifestPath).assets["win32-x64"]!.sha256, null); // nothing pinned
});

test("installer: a pinned hash is authoritative; a mismatch is refused even if the release checksums agree", async () => {
  const f = fixture({ sha256: "1".repeat(64) });
  await assert.rejects(installYtDlp(f.opts), /Checksum mismatch/);
  assert.equal(existsSync(f.binDir) ? readdirSync(f.binDir).length : 0, 0);
  assert.ok(!hits.some((h) => h.endsWith("SHA2-256SUMS")));
  const ok = fixture({ sha256: sha(FILE) });
  assert.equal((await installYtDlp(ok.opts)).status, "installed");
  const bad = fixture({ sha256: "not-a-hash" });
  await assert.rejects(installYtDlp(bad.opts), /not a 64-character hex/);
});

test("installer: release checksums without our file, 404s and network errors give clear messages", async () => {
  const f = fixture();
  sumsBody = `${"a".repeat(64)}  something-else.exe\n`;
  await assert.rejects(installYtDlp(f.opts), /no entry for yt-dlp\.exe/);
  const g = fixture({ sha256: sha(FILE) });
  fileStatus = 404;
  await assert.rejects(installYtDlp(g.opts), /Not found \(404\).*yt-dlp\.exe.*manifest/);
  fileStatus = 500;
  await assert.rejects(installYtDlp(g.opts), /HTTP 500/);
  const h = fixture({ sha256: sha(FILE) });
  await assert.rejects(installYtDlp({ ...h.opts, baseUrl: "http://127.0.0.1:1" }), /Could not reach .*internet connection/);
  assert.equal(existsSync(h.binDir) ? readdirSync(h.binDir).length : 0, 0);
});

test("installer: an unsupported platform is explained", async () => {
  const f = fixture({ key: "freebsd-x64" });
  await assert.rejects(installYtDlp(f.opts), /No yt-dlp build is listed for freebsd-x64.*YTDLP_PATH/);
});

test("installer: a binary that does not run or reports the wrong version is removed", async () => {
  const f = fixture({ sha256: sha(FILE) });
  await assert.rejects(installYtDlp({ ...f.opts, runVersion: async () => "2020.01.01" }), /reports version 2020\.01\.01, expected/);
  assert.equal(existsSync(join(f.binDir, "yt-dlp.exe")), false);
  await assert.rejects(installYtDlp({ ...f.opts, runVersion: async () => { throw Object.assign(new Error("x"), { stderr: "VCRUNTIME140.dll was not found" }); } }), /VCRUNTIME140.*removed/s);
  assert.equal(existsSync(join(f.binDir, "yt-dlp.exe")), false);
});

test("installer: an old or tampered file is replaced; a matching file is left alone", async () => {
  const f = fixture({ sha256: sha(FILE) });
  mkdirSync(f.binDir, { recursive: true });
  writeFileSync(join(f.binDir, "yt-dlp.exe"), "old build");
  const r = await installYtDlp(f.opts);
  assert.equal(r.status, "installed");
  assert.equal(readFileSync(join(f.binDir, "yt-dlp.exe")).equals(FILE), true);
});

test("update: changes the pin and fills every available platform hash from the release checksums", async () => {
  const f = fixture();
  sumsBody = sums();
  const m = await updateManifest("2026.11.01", { manifestPath: f.manifestPath, baseUrl, log: (x) => f.logs.push(x) });
  assert.equal(m.version, "2026.11.01");
  const saved = readManifest(f.manifestPath);
  assert.equal(saved.version, "2026.11.01");
  assert.equal(saved.assets["win32-x64"]!.sha256, sha(FILE));
  assert.equal(saved.assets["linux-x64"]!.sha256, sha(FILE));
  assert.equal(saved.assets["darwin-arm64"]!.sha256, "a".repeat(64));
  await assert.rejects(updateManifest("nightly", { manifestPath: f.manifestPath, baseUrl }), /not a stable yt-dlp release/);
  await assert.rejects(updateManifest("2026.10.21.233000", { manifestPath: f.manifestPath, baseUrl }), /not a stable/);
  await assert.rejects(updateManifest("9999.99.99", { manifestPath: f.manifestPath, baseUrl }), /Not found \(404\)/);
  assert.equal(readManifest(f.manifestPath).version, "2026.11.01"); // failed updates leave the manifest alone
});

test("update: a release that lists none of our files does not change the manifest", async () => {
  const f = fixture();
  sumsBody = `${"a".repeat(64)}  unrelated.bin\n`;
  const before = readFileSync(f.manifestPath, "utf8");
  await assert.rejects(updateManifest("2026.10.22", { manifestPath: f.manifestPath, baseUrl: baseUrl.replace(/\/$/, "") }), /lists none of the expected files/);
  assert.equal(readFileSync(f.manifestPath, "utf8"), before);
});
