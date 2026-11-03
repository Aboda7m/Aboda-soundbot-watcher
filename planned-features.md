# Planned features

Ideas for future work—not commitments or part of the current implementation.

## Playback

- **Improve the Stremio player** — improve the playback experience and address usability issues as they’re identified.

## Entrance sounds

- **Entrance-sound opt-out** — let a user prevent their own automatic entrance sound from playing.

## Recordings and privacy

- **Entrance-reaction recordings** — optionally capture the voice-channel reaction while an entrance sound plays. Save clips through the normal recording pipeline and show them in the recordings dashboard with the entrant and recorded speakers identified. Avoid per-entrance alert sounds and chat messages; follow the server’s existing recording-consent expectations.
- **Participant recording opt-out** — prevent a user’s voice from being included in future recordings. Decide whether this covers manual, follow, and entrance-reaction recordings, and what happens to an active recording when someone opts out.
- **Search recordings by Discord user ID** — find recordings containing a participant without relying on a username that may change.
- **Historical track deletion** — remove a participant’s audio from past recordings. Delete their audio files and update the corresponding manifests and any relevant indexes or caches, while preserving other participants’ tracks where possible.

The recordings dashboard already supports manually removing a participant’s track from an individual recording. The features above are future additions; they are not part of the current implementation.