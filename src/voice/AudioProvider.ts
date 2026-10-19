import { createAudioResource, StreamType, type AudioResource } from "@discordjs/voice";
import { createReadStream } from "node:fs";
import { extname } from "node:path";

/**
 * All codec / FFmpeg / stream-type knowledge lives here.
 *  - mp3, wav, anything else: a file path is handed to the voice library, which spawns FFmpeg and
 *    encodes to Opus (needs an ffmpeg binary on PATH).
 *  - .opus (Ogg Opus, 48 kHz stereo): read as a stream and demuxed directly: no FFmpeg process and
 *    no re-encode. (Passing a path string would silently fall back to FFmpeg: the library only honours
 *    inputType for streams. That is why this branch builds a stream.)
 */
export function createResource(filePath: string): AudioResource {
  if (extname(filePath).toLowerCase() === ".opus") {
    return createAudioResource(createReadStream(filePath), { inputType: StreamType.OggOpus, inlineVolume: false });
  }
  return createAudioResource(filePath, { inputType: StreamType.Arbitrary, inlineVolume: false });
}
