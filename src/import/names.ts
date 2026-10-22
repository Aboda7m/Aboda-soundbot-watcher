/**
 * Sound-name rules for imports. Pure functions, no file system.
 * A name becomes `<name><ext>` inside the sounds folder, so it must never contain a path separator,
 * a dot, a quote (the !sound command strips quotes), a leading/trailing space (Windows drops them),
 * or a Windows-reserved device name.
 */
export const MAX_NAME_LENGTH = 64;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// first char: letter/number. Rest: letters, numbers, combining marks (Arabic/Indic vowel signs), space, _ or -.
const VALID = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M} _-]*[\p{L}\p{N}\p{M}_-])?$/u;

/** The client-supplied file name, reduced to a plain base name. Used only for display, the extension check and suggestions. */
export function cleanUploadName(raw: string): string {
  const base = raw.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop() ?? "";
  return base.trim().slice(0, 255);
}

/** Turn an uploaded file name into a valid sound name suggestion, or "" if nothing usable is left. */
export function suggestName(fileName: string): string {
  const base = cleanUploadName(fileName);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  let name = stem
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M} _-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  if (RESERVED.test(name)) name = `${name} clip`;
  return VALID.test(name) ? name : "";
}

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

export function checkName(raw: unknown): NameCheck {
  if (typeof raw !== "string") return { ok: false, error: "Name must be text." };
  const name = raw.normalize("NFC").trim();
  if (!name) return { ok: false, error: "Enter a name for the sound." };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `Name can be at most ${MAX_NAME_LENGTH} characters.` };
  if (RESERVED.test(name)) return { ok: false, error: "That name is reserved by Windows. Pick another." };
  if (!VALID.test(name))
    return { ok: false, error: "Use letters, numbers, spaces, - and _ only (start with a letter or number)." };
  return { ok: true, name };
}
