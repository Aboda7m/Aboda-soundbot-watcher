# Voice worker implementation status

Implemented in this revision:

- Optional `VOICE_WORKER_1_TOKEN` and `VOICE_WORKER_2_TOKEN` environment variables. The actual `.env` is not included or modified.
- Separate lightweight Discord clients for workers, using Guilds and Guild Voice States intents only.
- Per-bot `@discordjs/voice` connection groups to isolate the main bot and worker connections in the same process.
- Per-guild/per-channel playback queues, allowing different voice channels in the same server to progress independently.
- Worker allocation for extra channels, with Worker 2 preferred for a separate recording connection.
- Recording uses a leased pool connection, can share a connection already in the recording channel, and releases it after recording files are flushed.
- `!voice setup` produces OAuth invite links for workers. A server Administrator must authorize each worker; bots cannot authorize other bots.
- `!voice status` reports worker membership and connection state.
- Worker login failures are non-fatal to the main bot.

Not implemented in this revision:

- Simultaneous mixing of up to five entrance sounds in the *same* voice channel. Playback within one channel remains serial because the existing adapter has one AudioPlayer per bot connection. A real FFmpeg mixer and batch playback path are still required for this feature. The project README and `voice-pool.json` state this explicitly.

Validation:

- TypeScript syntax checks passed for all modified TypeScript files.
- Full typecheck was unavailable because dependencies/types could not be installed in this environment.
- The test run executed 125 passing tests; 16 failed because this environment has Node 22.16.0 (the project requires >=22.18) and the dependency installation timed out, leaving required packages such as `discord.js` and `@discordjs/voice` unavailable. These failures are environment limitations, not a clean passing test run.
