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
| `src/discord/` | client and intents | Gateway only |
| `src/index.ts` | wiring | No |

If voice breaks after a discord.js / @discordjs/voice update, fix `src/voice/` and nothing else.
Keep `package-lock.json` committed: it pins the exact versions that worked.
Startup prints nothing about voice libraries; to check Opus/DAVE/FFmpeg run
`node -e "import('@discordjs/voice').then(v=>console.log(v.generateDependencyReport()))"`.

## Migrating from the legacy bot

Nothing is moved or deleted. Point `SOUNDS_DIR` and `DB_PATH` at the legacy `sounds/` and `db.json`
(or copy them first). The same file format is used (`entrances`, `exits`, `ignoreList`, `sounds`).
Before the first write a copy is saved as `db.json.bak`. A malformed db.json stops startup and is left untouched.
Do not run the legacy bot and this one against the same db.json at the same time.

## API (loopback by default)

    GET  /api/voice    current voice snapshot        GET /events   live stream (SSE)
    GET  /api/sounds   names, play counts, tags      GET /api/status  playback queue
    POST /api/play     {"sound","guildId","channelId"}   JSON only, header X-Access-Key if ACCESS_KEY is set

## Optional: pre-convert hot sounds (about 10x less CPU per play)

    ffmpeg -i airhorn.mp3 -ar 48000 -ac 2 -c:a libopus -b:a 64k airhorn.opus

Add `.opus` first in `ACCEPTED_EXTENSIONS` and it wins over the mp3/wav of the same name.

## Import page: `/import`

Upload an audio file, preview it, name it, and save it into `SOUNDS_DIR`. The sound is available straight away (no restart);
reload the soundboard page to see it in the grid.

- Needs `ffmpeg` and `ffprobe` on PATH (or `FFMPEG_PATH` / `FFPROBE_PATH`). `IMPORT_ENABLED=0` removes the page and API.
- Accepted uploads: MP3, WAV, OGG, OPUS, M4A, AAC, FLAC. Limits: `IMPORT_MAX_UPLOAD_MB` (10) and `IMPORT_MAX_DURATION_SEC` (30).
- Real MP3/WAV files are saved untouched. Anything else is converted to 48 kHz stereo MP3 (WAV if `.mp3` is not in `ACCEPTED_EXTENSIONS`).
- Same access rules as playback: with `ACCESS_KEY` set open `/import?key=...`; beyond localhost without a key, uploads are refused.
- Never overwrites: a name that already exists (any letter case) is refused. Names: letters, numbers, spaces, `-`, `_`.

      GET  /api/import/config  limits + readiness      POST /api/import/upload   raw file body, X-Filename header
      GET  /api/import/preview/<id>                    POST /api/import/save     {"id","name"}
      POST /api/import/discard {"id"}

