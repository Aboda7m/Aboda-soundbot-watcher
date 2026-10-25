# aboda-soundbot

Voice-channel dashboard + soundboard bot. One Discord client, no build step.

    npm install
    cp .env.example .env     # set DISCORD_TOKEN, SOUNDS_DIR, DB_PATH
    npm start                # node src/index.ts  (Node >= 22.18; edit a file, restart, done)
    npm run dev              # same, restarts on file changes
    npm test                 # 32 tests, no Discord needed
    npm run bench            # decode CPU: node scripts/bench.ts <file> <plays>

Edits to `public/*` need only a browser refresh. Edits to `db.json` are picked up live.

## Where things live (and what to touch when Discord changes)

| Folder | Role | Knows about Discord voice? |
|---|---|---|
| `src/voice/` | `DiscordVoiceAdapter` (join/leave/player), `AudioProvider` (FFmpeg/Opus/stream types) | **Yes. The only place** |
| `src/sound/` | library, db.json repository, intro rules, queue | No (talks to `VoicePort` only) |
| `src/watcher/` | voice-list snapshot + live push | No voice API, reads discord.js caches |
| `src/http/` | local page + API | No |
| `src/discord/` | client, intents, text commands (`commands/*.command.ts`) | Gateway only |
| `src/index.ts` | wiring | No |

If voice breaks after a discord.js / @discordjs/voice update, fix `src/voice/` and nothing else.
Keep `package-lock.json` committed: it pins the exact versions that worked.
Startup prints nothing about voice libraries; to check Opus/DAVE/FFmpeg run
`node -e "import('@discordjs/voice').then(v=>console.log(v.generateDependencyReport()))"`.

## Text commands

Each chat command lives in its own file in `src/discord/commands/` and is discovered when the bot starts.

| Command | File |
|---|---|
| `!sound <name>` | `sound.command.ts` |
| `!soundlist` | `soundlist.command.ts` |
| `!entrance`, `!RM-entrance` | `entrance.command.ts` |
| `!import <url> [from X to Y]` | `import.command.ts` |

Shared code: `textCommand.ts` (pure parsing and sound search), `commandTypes.ts` (the interface below),
`commandUtils.ts` (reply helpers), `commandRegistry.ts` (the loader), `textCommands.ts` (dispatch).

### Adding a text command

Create `src/discord/commands/<name>.command.ts`. No other file needs editing. Example `ping.command.ts`:

```ts
import { defineTextCommand } from "../commandTypes.ts";

export default defineTextCommand({
  names: ["ping", "pong"],              // lowercase, no prefix; the first is the canonical name, the rest are aliases
  description: "Replies with pong",     // shown in the startup log and in error messages
  // Only called when the first word is one of `names` (any capitalisation). Return null to stay silent.
  parse: (content) => ({ args: content.trim().split(/\s+/).slice(1) }),
  // `message` is the Discord message, `deps` is { library, queue, prefix, importer?, repo? }.
  execute: async ({ message }, { args }) => {
    await message.reply(`pong ${args.join(" ")}`.trim());
  },
});
```

Rules, all checked at startup (a violation stops the bot with a message listing every problem):
- the file name ends in `.command.ts`, directly inside `commands/` (no subfolders, no other `.ts` files there);
- the default export comes from `defineTextCommand(...)`;
- names match `[a-z0-9][a-z0-9_-]*` and are unique across all commands (a duplicate is an error, never a silent override);
- parsing helpers (`parseXxx`, `searchSound`, `chunkLines`, ...) belong in `textCommand.ts`; reply helpers (`say`, `formatChoices`) are in `commandUtils.ts`.

Commands are loaded once at startup. Restart the bot after adding a file (`npm run dev` watches files it has
already loaded, so it may not notice a brand-new one). Only messages sent in a server channel by non-bots reach a command.

## Migrating from the legacy bot

Nothing is moved or deleted. Point `SOUNDS_DIR` and `DB_PATH` at the legacy `sounds/` and `db.json`
(or copy them first). The same file format is used (`entrances`, `exits`, `ignoreList`, `sounds`).
Before the first write a copy is saved as `db.json.bak`. A malformed db.json stops startup and is left untouched.
Do not run the legacy bot and this one against the same db.json at the same time.

## Network layout: two listeners

| | Public dashboard | Local integration API |
|---|---|---|
| Default address | `127.0.0.1:3939` (`PUBLIC_HOST`, `PORT`) | `127.0.0.1:3940` (`LOCAL_HOST`, `LOCAL_PORT`) |
| Meant for | browsers, through the Cloudflare Tunnel | scripts, dev tools, the Nexus panel on this PC / LAN |
| Authentication | **Discord OAuth2** + server-side session cookie. Nothing else. | tools: `X-Access-Key` **header**; browsers: type the key once on the sign-in page, then a session cookie |
| Routes | dashboard pages, `/api/*`, `/events`, `/import`, `/logs`, `/auth/*` | the playback/voice API + `/events`, and for a signed-in browser the dashboard page (no import, no logs) |
| Tunnel origin? | **yes, the only one** | **never** |

The two listeners share the sound queue and library but no authentication code or state. The old `ACCESS_KEY` /
`X-Access-Key` / `?key=` mechanism is gone from the public listener; a key is worthless there and a dashboard session
is worthless on the local listener (both are covered by `test/authIsolation.test.ts`).

### Public dashboard: Discord sign-in

What you see: open the public URL, press **Login with Discord**, authorize on Discord's own page, and you land on the dashboard.
You never type Discord credentials, client ids, secrets or tokens into the dashboard. Those stay in the server's `.env`.

**Which Discord values are which**

| `.env` variable | What it is | Where it is used |
|---|---|---|
| `DISCORD_TOKEN` | the bot's token (already set up) | the bot connecting to Discord. Never used for sign-in |
| `DISCORD_CLIENT_ID` | the application's id (identifies *your app* to Discord) | OAuth authorize URL (public by nature) |
| `DISCORD_CLIENT_SECRET` | the application's OAuth secret | server-side only, sent once to Discord's token endpoint |

None of these is a user's password. The client secret is never sent to the browser, put in a page, URL, API response or log
(`test/publicHostAndLogin.test.ts` checks this against a real run of the flow).

**You can reuse the bot's existing Discord application.** A bot lives inside an application, and the same application has an OAuth2
section. The client id equals the bot's id: it is in the `Invite:` link the bot prints at startup (`client_id=...`).

**Discord Developer Portal** (https://discord.com/developers/applications > your bot's application):
1. **OAuth2 > Client information:** copy **Client ID**; press **Reset Secret** to get the **Client Secret** (shown once; resetting does
   not affect the bot token). Put both in `.env`.
2. **OAuth2 > Redirects > Add Redirect:** exactly `PUBLIC_BASE_URL` + `/auth/callback`, for example
   `https://dash.example.com/auth/callback`. Scheme, host and path must match character for character.
3. Scope: **`identify`** only (the server requests it itself; nothing to tick for the login). No bot permissions are involved.

**`.env` values**

| Variable | Needed? | Meaning |
|---|---|---|
| `PUBLIC_BASE_URL` | **required** | the address people type, e.g. `https://dash.example.com` (no path, no trailing slash) |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | **required** | see above |
| `DASHBOARD_ALLOWED_USER_IDS` and/or `DASHBOARD_GUILD_ID` | **at least one required** | who may sign in; with neither, **nobody** can (fail closed) |
| `DASHBOARD_ROLE_IDS` | optional | with `DASHBOARD_GUILD_ID`: only members holding one of these roles |
| `SESSION_MAX_HOURS` | optional, 12 | absolute session lifetime |
| `SESSION_RECHECK_MINUTES` | optional, 10 | how often live sessions are re-authorized (0 = off) |
| `PUBLIC_HOST` | optional, `127.0.0.1` | bind address of the tunnel origin. Leave it alone |
| `PORT` | optional, 3939 | port of the tunnel origin |

Everything else in your `.env` (sounds, queue, imports, FFmpeg, yt-dlp, database paths...) is untouched. To add the new lines without
rewriting your file (PowerShell, from the project folder; edit the values afterwards, and remove an old `HOST=` line if you have one):

    Add-Content .env "`nPUBLIC_BASE_URL=https://dash.example.com`nDISCORD_CLIENT_ID=`nDISCORD_CLIENT_SECRET=`nDASHBOARD_ALLOWED_USER_IDS="

**Who may sign in.** After Discord proves who you are, the server (never the browser) decides: you are an **owner**
(`OWNER_USER_IDS`, or the older `DASHBOARD_ALLOWED_USER_IDS`), or the owner gave you the `dashboard` permission (see
[Access control](#access-control-who-may-use-the-bot-and-who-may-do-what)), or you are a member of `DASHBOARD_GUILD_ID` (the bot
must be in that server; optionally holding one of `DASHBOARD_ROLE_IDS`). Guild members get the dashboard (view and play) only; import
and logs always need a grant. A blocked user is refused whatever else applies. Client-supplied identities are never trusted.
**"Access denied. This Discord account is not allowed" means none of those matched your Discord user id.**
Put your own id in `OWNER_USER_IDS` (Discord > Settings > Advanced > Developer Mode, then right-click yourself > Copy User ID).

**Tunnel setup.** Point the tunnel at `http://127.0.0.1:3939` and leave Cloudflare's *HTTP Host Header* origin setting empty (its default),
so the original hostname reaches the server. Only the tunnel hostname is served: any other `Host` gets HTTP 421.

**Troubleshooting HTTP 421.** 421 means the `Host` header of the request is not the host in `PUBLIC_BASE_URL`; nothing else produces it.
The console prints one line per refused value, for example `refused a request with Host "127.0.0.1:3939" ... it only serves "dash.example.com"`.
- `PUBLIC_BASE_URL` unset: the server expects `localhost:3939`, so the tunnel hostname, `127.0.0.1` and LAN addresses all give 421.
- Browsing the tunnel hostname but `PUBLIC_BASE_URL` has a different one, or a different scheme/port in dev: fix `PUBLIC_BASE_URL`.
- Local development: set `PUBLIC_BASE_URL=http://localhost:3939`, add `http://localhost:3939/auth/callback` as a redirect in the portal
  (Discord accepts http for localhost), and open exactly `http://localhost:3939/`.
No proxy header (`X-Forwarded-Host`, `Forwarded`, `CF-*`) is trusted for anything; the cookie's `Secure` flag comes from `PUBLIC_BASE_URL`.

**Which address is the public listener really on?** `PUBLIC_HOST` (default `127.0.0.1`). The old generic `HOST` is honored only if it is a
loopback address: an old `HOST=0.0.0.0` is ignored (with a startup warning) so a LAN setting from the one-listener days cannot widen the
tunnel origin. Note that a variable set in Windows' environment beats the same name in `.env` (Node's `--env-file` does not override it).
Check: `findstr /b "HOST PUBLIC_HOST" .env` and `echo %HOST%`; the `Public dashboard: listening on ...` line shows the effective value.

**How the login works.** Scope `identify` only, authorization-code flow with PKCE (S256; Discord lists it in its published OAuth metadata
at `https://discord.com/.well-known/oauth-authorization-server`) and a `state`. The state is single-use, expires after 10 minutes, and is
also bound to the browser that started the login by a short-lived cookie, so a login link made by someone else is rejected. The access
token is used once to read your user id and is then revoked. The session id is random, kept only in server memory (**a bot restart signs
everybody out**), and sent as an `HttpOnly; SameSite=Lax` cookie (`__Host-` prefixed and `Secure` when `PUBLIC_BASE_URL` is https). It
expires `SESSION_MAX_HOURS` after sign-in no matter what. Writes need a JSON (or upload) content type **and** an `Origin` header that is
exactly your site. `POST /auth/logout`, expiry or revocation also close that session's live event streams.

**Changes after sign-in.** Every `SESSION_RECHECK_MINUTES` the server re-checks each live session against the current rules. Losing
the role or leaving the server ends the session (and its stream) within that interval. If Discord cannot be reached the check is
inconclusive and sessions are kept until they expire. Removing a user id from `DASHBOARD_ALLOWED_USER_IDS` needs a bot restart (which
ends all sessions anyway).

### Access control: who may use the bot and who may do what

Everything is decided by Discord **user and server ids** that you choose. Discord's own "administrator" / "Manage Server" is never
consulted, because everybody is an administrator of their own server. (Ids, not usernames: a username can be changed or imitated, an id cannot.)

**Owners** are the ids in `OWNER_USER_IDS` in `.env` (comma separated). Owners can do everything, bypass the whitelist and blacklist, and cannot be
blocked, so you cannot lock yourself out. Nobody becomes an owner from inside Discord.

**Two switches, both off by default, so the bot is global like before.** Turn them on and off whenever you like; no restart:

| Switch | When ON |
|---|---|
| whitelist | the bot only reacts in **allowed servers**, or to **allowed users** anywhere. Commands *and* automatic entrance/exit sounds, and dashboard playback targets |
| blacklist | **blocked servers** and **blocked users** are ignored everywhere. A blocked user also loses dashboard access and every permission |

The lists can be filled while a switch is off. Not-allowed and blocked people get no reply at all.

**Permissions** (granted per user id; owners have all of them):

| Permission | Lets the user |
|---|---|
| `dashboard` | sign in to the web dashboard, see it and play sounds |
| `import` | add sounds to the shared library: `!import` and the dashboard Import page |
| `entrance.manage` | set or clear **someone else's** entrance sound (`!entrance @user ...`) |
| `logs` | open the dashboard Logs page |

Everyone else can still play sounds and set their **own** entrance sound (as long as the whitelist/blacklist let them in). Before this
change `!import` had no permission check at all and `!entrance @user` relied on Manage Server; both now need the grants above.

**Owner-only commands** (anyone else gets no reply). Mention the user or paste their id; `here` means the server you type it in:

    !access                                  show the current settings         !access list   (DM with every id)
    !access whitelist on|off                 !access blacklist on|off
    !access allow|unallow server <id|here>   !access allow|unallow user <@user|id>
    !access block|unblock server <id|here>   !access block|unblock user <@user|id>
    !access grant|revoke <@user|id> <dashboard|import|entrance.manage|logs>

Typical use: `!access whitelist on`, then `!access allow server here` in each server you trust; later `!access whitelist off` to go global again.

The settings live in `access.json` (`ACCESS_FILE` to move it). You can edit it by hand while the bot runs (a broken edit is reported and the
previous rules stay in force; a broken file at startup stops the bot instead of guessing). Changes made by `!access` or by hand apply
immediately to commands and to dashboard requests. A user who loses `dashboard` or is blocked is signed out on their next request.

### Local (private) dashboard in a browser on your network

Open `http://<this PC's 192.168.x.x address>:3940/` and type the local access key into the sign-in page. The key goes in a form
POST, never in the URL; the server then gives your browser its own session cookie. A `?key=...` in the address bar does nothing.
You get the playback dashboard only (no Import, no Logs: those exist only on the Discord-protected public dashboard). Tools and
scripts keep using the `X-Access-Key` header. `LOCAL_DASHBOARD=0` turns the browser part off.

To reach it from other devices set, in `.env`:

    LOCAL_HOST=192.168.1.20          (this PC's own LAN address: run ipconfig, look for "IPv4 Address")
    LOCAL_ACCESS_KEY=<long random value>

**Use the PC's 192.168.x.x address, not 0.0.0.0.** `0.0.0.0` does not mean "local network only": it means *every* network interface
the PC has (Wi-Fi, Ethernet, VPN adapters, anything a tunnel or hotspot adds). Binding to the 192.168 address gives exactly "LAN only".
Give the PC a fixed address (router DHCP reservation) so it does not change. If you still want all interfaces, startup refuses unless you add
`LOCAL_ALLOW_ALL_INTERFACES=1`, and then the firewall rule below is what keeps it LAN-only.

This is plain http: on a LAN, anyone who can sniff the network could read the key. Use it on a home network you trust, never over the
internet and never through the tunnel. Wrong keys are rate-limited (8 per 10 minutes per address), and only Host names that look like
a private network (IP address, PC name, `.local`/`.lan`) are answered.

Firewall rule that allows the local subnet only (run as Administrator; no rule is needed for loopback-only use):

    New-NetFirewallRule -DisplayName "Aboda local 3940 (LAN only)" -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort 3940 -RemoteAddress LocalSubnet -Profile Private

### Local integration API

    GET  /api/voice    current voice snapshot        GET /events      live stream (SSE)
    GET  /api/sounds   names, play counts, tags      GET /api/status  playback queue
    POST /api/play     {"sound","guildId","channelId"}                (JSON only)
    POST /api/queue/skip | /api/queue/remove | /api/queue/clear-pending

Send the key as `X-Access-Key: <key>` on **every** request (reads and `/events` included). It is never accepted in the URL, so
native `EventSource` (which cannot set headers) cannot be used. Read the stream with `fetch` instead:

    const res = await fetch("http://127.0.0.1:3940/events", { headers: { "X-Access-Key": KEY }, signal });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;                         // reconnect with a delay here
      buf += value;
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
        const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (data) handle(JSON.parse(data));
      }
    }

The Nexus widget's code was not available when this was written: whether it uses `EventSource` + `?key=` is unverified, and if it does it
must be changed to the header form above. There is no CORS:
browsers on other origins cannot call it. It does not serve the dashboard, `/import` or `/logs`.

The listener only starts when a key exists: `LOCAL_ACCESS_KEY`, or your existing `ACCESS_KEY`, which now means "local key" and nothing
else. Use a long random value, for example `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
`LOCAL_HOST` must be `127.0.0.1` or one specific address of this PC; `0.0.0.0` / `::` are refused at startup.

### What actually keeps the local API private

A different port is not a security boundary, and neither is a bind address by itself. What you get:

- **`LOCAL_HOST=127.0.0.1` (default):** only processes on this PC can connect. Other devices cannot, unless something running on this PC
  forwards to it. Things that do that: a `cloudflared` ingress rule or WARP/private-network route that points at it, `netsh interface portproxy`,
  an SSH/VPN/RDP port forward, a reverse proxy, or other software that proxies localhost. Do not add any of these for port 3940.
  Any local program (or malware) running as any user on the PC can still try to connect; the access key is what stops it.
- **`LOCAL_HOST=<LAN address>` (only if a device on the LAN, such as the Nexus panel, must reach it):** every device that can reach that address
  can connect, so add the firewall rule below and keep the access key secret. Whether it is reachable from the internet depends on your router
  (port forwarding, UPnP, DMZ, IPv6 firewalling) and on the tunnel configuration, not on this setting.
- **Cloudflare Tunnel:** the ingress must list one service, `http://127.0.0.1:3939`, with `http_status:404` as the catch-all. Never list port 3940, a
  wildcard hostname, or `localhost` services you did not intend to publish.

Check it yourself rather than trusting the config:

    netstat -ano | findstr ":3939 :3940"          (expect 127.0.0.1 or your one LAN address, never 0.0.0.0 or [::])
    curl.exe -i http://127.0.0.1:3940/api/sounds   (expect 401)
    curl.exe -i -H "X-Access-Key: KEY" http://127.0.0.1:3940/api/sounds   (expect 200)
    curl.exe -i "http://127.0.0.1:3940/api/sounds?key=KEY"                (expect 401)
    curl.exe -i https://YOUR-HOSTNAME/api/sounds   (expect 401; and the tunnel must not answer for port 3940 at all)
    from a phone on mobile data (not Wi-Fi): http://YOUR-PUBLIC-IP:3940 must not connect

### Windows Firewall

Loopback traffic is not filtered by Windows Firewall, and `cloudflared` only makes outbound connections, so with the default binds
**no inbound rule is needed for 3939 or 3940, and none should exist.** Run as Administrator.

Check for rules that already allow these ports (a broad "Node.js" allow rule created by the first-run prompt is common):

    Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True |
      Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -in '3939','3940','Any' -and $_.Protocol -in 'TCP','Any' }
    Get-NetFirewallApplicationFilter | Where-Object Program -like '*node.exe'

If (and only if) a LAN device must reach the local API, bind `LOCAL_HOST` to the PC's LAN address and allow just those devices:

    New-NetFirewallRule -DisplayName "Aboda local API 3940 (LAN allow-list)" -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort 3940 -LocalAddress 192.168.1.20 -RemoteAddress 192.168.1.50,192.168.1.60 -Profile Private
    New-NetFirewallRule -DisplayName "Aboda local API 3940 (block everyone else)" -Direction Inbound -Action Block -Protocol TCP `
      -LocalPort 3940 -Profile Public,Domain

Give the PC (and the panel) fixed addresses, replace the example addresses, and note that Windows evaluates Block rules before Allow
rules: the block above is limited to the Public and Domain profiles so it does not cancel the Private-profile allow. Mark the home network
as Private, not Public. Do not create any inbound rule for 3939.

## Optional: pre-convert hot sounds (about 10x less CPU per play)

    ffmpeg -i airhorn.mp3 -ar 48000 -ac 2 -c:a libopus -b:a 64k airhorn.opus

Add `.opus` first in `ACCEPTED_EXTENSIONS` and it wins over the mp3/wav of the same name.

## Import page: `/import`

Upload an audio **or video** file, choose what to keep, preview it, name it, and save it into `SOUNDS_DIR`. The sound is available
straight away (no restart); reload the soundboard page to see it in the grid.

- Needs `ffmpeg` and `ffprobe` on PATH (or `FFMPEG_PATH` / `FFPROBE_PATH`). `IMPORT_ENABLED=0` removes the page and API.
  The page checks what your FFmpeg build can read/write and only offers those formats.
- Accepted: MP3, WAV, OGG/Opus, FLAC, AAC, AIFF, WMA, M4A, MP4, MOV, MKV, WebM, AVI, 3GP and similar. The file's real content is checked, not its name.
  For video only the audio track is used; a file with no audio track is refused.
- **What to keep:** by default the first `IMPORT_DEFAULT_TRIM_SEC` seconds (10). The user can instead pick a custom range (start + end, or start + length)
  or "Full audio". Long sources are fine; the saved sound is limited to `IMPORT_MAX_OUTPUT_SEC` (600) and `IMPORT_MAX_OUTPUT_MB` (64).
  The page shows the original length and the length that will be saved, and Save is only enabled while the preview matches the chosen settings.
- Real MP3/WAV files that need no trimming are saved untouched. Everything else becomes 48 kHz stereo MP3 (WAV if `.mp3` is not in `ACCEPTED_EXTENSIONS`).
- Limits: `IMPORT_MAX_UPLOAD_MB` (100) for the original file, one FFmpeg job at a time, a timeout per job (`IMPORT_PROCESS_TIMEOUT_SEC`),
  at most 3 pending imports, a free-disk-space check, and staged files are deleted after 30 minutes.
- Same access rules as the rest of the dashboard: you must be signed in with Discord (public listener only; `/import` is not served on the local API).
- Never overwrites: a name that already exists (any letter case) is refused. Names: letters, numbers, spaces, `-`, `_`.

      GET  /api/import/config   limits, formats, readiness       POST /api/import/upload   raw file body, X-Filename header
      GET  /api/import/preview/<id>                              POST /api/import/process  {"id","mode":"first"|"range"|"full","start","end"|"duration"}
      POST /api/import/save     {"id","name"}                    POST /api/import/discard  {"id"}

## Portable yt-dlp (for URL imports, coming later)

The bot carries its own pinned `yt-dlp` so nothing has to be installed globally. Nothing uses it for imports yet; at startup the bot only logs whether it is found.

| | |
|---|---|
| Stored at | `tools/yt-dlp/bin/yt-dlp.exe` (Windows) or `tools/yt-dlp/bin/yt-dlp` (Linux/macOS). Git-ignored. Found relative to the project, so the working directory does not matter. |
| Pinned version | `tools/yt-dlp/manifest.json` (`version`, plus a SHA-256 per platform). Commit this file. |
| Source | the official `yt-dlp/yt-dlp` GitHub release for that exact version (standalone build, no Python needed) |

    npm run ytdlp:install                 download the pinned version into tools/yt-dlp/bin (no-op if already installed)
    npm run ytdlp:install -- --force      reinstall
    npm run ytdlp:check                   show the path, pinned version and the version that actually runs
    npm run ytdlp:update -- 2026.10.21    change the pin (reads that release's checksums); then run ytdlp:install

- **Verify:** `npm run ytdlp:check` prints `Version:` from `yt-dlp --version` and warns if it differs from the pin. Or run `tools\yt-dlp\bin\yt-dlp.exe --version` yourself.
- **Integrity:** every download is checked against a SHA-256. If the manifest has none yet for your platform, the installer takes it from the release's `SHA2-256SUMS` file, and writes it into the manifest so later installs are checked against the pinned value.
- **No automatic updates:** nothing runs on `npm install`, and the bot never calls `yt-dlp -U`. Update only with `ytdlp:update`. Stable releases only (e.g. `2026.10.21`).
- **Custom location:** set `YTDLP_PATH` in `.env` to use a different executable (the pin is then not compared).
- **Windows:** if it will not start, install the Microsoft Visual C++ 2015-2022 Redistributable (x64) and check that antivirus did not quarantine the file.
- **For later:** run it with `--ignore-config` (a `yt-dlp.conf` next to the binary is otherwise loaded). YouTube also needs a JavaScript runtime for yt-dlp; only `deno` is enabled by default, Node can be enabled with `--js-runtimes node`.
- **License:** yt-dlp is Unlicense, but the standalone `.exe` bundles GPLv3+ code. That is why the binary is downloaded from the official release instead of being committed to the repository.
