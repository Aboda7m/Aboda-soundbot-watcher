import { readdirSync, statSync } from "node:fs";
import { join, parse } from "node:path";

/**
 * Discovers sound files and is the ONLY place that turns a sound name into a file path.
 * Names come from a directory scan, never from concatenating user input, so a request
 * like "../../etc/passwd" simply isn't in the map.
 */
export class SoundLibrary {
  #dir: string;
  #exts: string[];
  #map = new Map<string, string>(); // name -> absolute path
  #mtime = -1;
  #warnedMissing = false;

  constructor(dir: string, acceptedExtensions: string[]) {
    this.#dir = dir;
    this.#exts = acceptedExtensions.map((e) => e.toLowerCase());
  }

  #refresh() {
    let mtime: number;
    try {
      mtime = statSync(this.#dir).mtimeMs;
    } catch {
      if (!this.#warnedMissing) console.warn(`Sounds folder not found: ${this.#dir}`);
      this.#warnedMissing = true;
      this.#map.clear();
      this.#mtime = -1;
      return;
    }
    if (mtime === this.#mtime) return; // directory unchanged: no rescan
    this.#mtime = mtime;

    const next = new Map<string, string>();
    const files = readdirSync(this.#dir, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith("."))
      .map((d) => parse(d.name))
      .filter((p) => this.#exts.includes(p.ext.toLowerCase()))
      // When both foo.mp3 and foo.wav exist, the extension listed first in ACCEPTED_EXTENSIONS wins.
      .sort((a, b) => this.#exts.indexOf(a.ext.toLowerCase()) - this.#exts.indexOf(b.ext.toLowerCase()));
    for (const p of files) if (!next.has(p.name)) next.set(p.name, join(this.#dir, p.base));
    this.#map = next;
  }

  list(): string[] {
    this.#refresh();
    return [...this.#map.keys()].sort((a, b) => a.localeCompare(b));
  }

  has(name: string): boolean {
    this.#refresh();
    return this.#map.has(name);
  }

  /** Absolute file path for a known sound, or null. */
  resolve(name: string): string | null {
    this.#refresh();
    return this.#map.get(name) ?? null;
  }
}
