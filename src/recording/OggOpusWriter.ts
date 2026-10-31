import { Transform, type TransformCallback } from "node:stream";

/**
 * Wraps raw Opus packets (what @discordjs/voice's receiver emits) into a valid Ogg Opus stream,
 * so the files play in VLC, ffmpeg, Audacity, browsers... No external dependency.
 * Each input chunk must be exactly one Opus packet (20 ms = 960 samples @ 48 kHz).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0;
  for (const byte of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc >>> 0;
}

const SAMPLES_PER_PACKET = 960;
const FRAME_MS = 20;
/** Pauses shorter than this are treated as network jitter and left alone. */
const MIN_GAP_MS = 100;
/** Never insert more than this much silence at once (the session already splits files after longer pauses). */
const MAX_FILL_FRAMES = 150;
/** A valid 20 ms Opus silence frame (the same one Discord clients send). */
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
const PRE_SKIP = 312;

export class OggOpusWriter extends Transform {
  readonly #serial = (Math.random() * 0xffffffff) >>> 0;
  #seq = 0;
  #granule = 0n;
  #held: Buffer | null = null;
  #started = false;
  #lastArrival: number | null = null;

  constructor() {
    super({ readableObjectMode: true, writableObjectMode: true });
  }

  #page(packet: Buffer, flags: number, granule: bigint): Buffer {
    const segs: number[] = [];
    let left = packet.length;
    while (left >= 255) {
      segs.push(255);
      left -= 255;
    }
    segs.push(left);

    const header = Buffer.alloc(27 + segs.length);
    header.write("OggS", 0, "ascii");
    header[4] = 0; // version
    header[5] = flags;
    header.writeBigUInt64LE(granule, 6);
    header.writeUInt32LE(this.#serial, 14);
    header.writeUInt32LE(this.#seq++, 18);
    header.writeUInt32LE(0, 22); // checksum placeholder
    header[26] = segs.length;
    segs.forEach((s, i) => (header[27 + i] = s));

    const page = Buffer.concat([header, packet]);
    page.writeUInt32LE(crc32(page), 22);
    return page;
  }

  #writeHeaders(): void {
    const head = Buffer.alloc(19);
    head.write("OpusHead", 0, "ascii");
    head[8] = 1; // version
    head[9] = 2; // channels (Discord is stereo)
    head.writeUInt16LE(PRE_SKIP, 10);
    head.writeUInt32LE(48000, 12);
    head.writeInt16LE(0, 16); // gain
    head[18] = 0; // mapping family
    this.push(this.#page(head, 0x02, 0n)); // BOS

    const vendor = Buffer.from("aboda-soundbot", "ascii");
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write("OpusTags", 0, "ascii");
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length);
    this.push(this.#page(tags, 0, 0n));
  }

  /** Writes one packet, holding it back by one so the final packet can carry the end-of-stream flag. */
  #emit(packet: Buffer): void {
    if (this.#held) {
      this.#granule += BigInt(SAMPLES_PER_PACKET);
      this.push(this.#page(this.#held, 0, this.#granule + BigInt(PRE_SKIP)));
    }
    this.#held = Buffer.from(packet);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (!this.#started) {
      this.#started = true;
      this.#writeHeaders();
    }

    // Discord sends nothing while someone is silent. Without compensation those pauses vanish and the
    // speech sounds rushed and choppy, so put the missing 20 ms frames back as silence.
    const now = performance.now();
    if (this.#lastArrival !== null) {
      const gapMs = now - this.#lastArrival;
      if (gapMs >= MIN_GAP_MS) {
        const missing = Math.min(MAX_FILL_FRAMES, Math.round(gapMs / FRAME_MS) - 1);
        for (let i = 0; i < missing; i++) this.#emit(SILENCE_FRAME);
      }
    }
    this.#lastArrival = now;

    this.#emit(chunk);
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this.#started && this.#held) {
      this.#granule += BigInt(SAMPLES_PER_PACKET);
      this.push(this.#page(this.#held, 0x04, this.#granule + BigInt(PRE_SKIP)));
    }
    this.#held = null;
    cb();
  }
}
