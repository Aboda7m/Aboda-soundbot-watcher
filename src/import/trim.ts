/**
 * Trim rules for imports. Pure functions: no file system, no FFmpeg.
 * A request says which part of the source audio to keep; this validates it against the real source duration.
 */

export interface TrimLimits {
  /** length of the default "first N seconds" selection */
  defaultSec: number;
  /** longest sound that may be saved (custom range or full audio) */
  maxOutputSec: number;
}

export interface TrimPlan {
  mode: "first" | "range" | "full";
  startSec: number;
  /** length of the kept part; null = "everything from start" (full audio of a source whose length is unknown) */
  lengthSec: number | null;
  /** false when the whole source is kept (so an MP3/WAV can be saved untouched) */
  needsTrim: boolean;
}

export type TrimResult = { ok: true; plan: TrimPlan } | { ok: false; error: string };

/** Header durations are rounded; ignore differences smaller than this. */
export const DURATION_EPSILON = 0.25;
export const MIN_OUTPUT_SEC = 0.1;

const fmt = (s: number) => (s >= 100 ? s.toFixed(0) : s.toFixed(1)).replace(/\.0$/, "");

function num(v: unknown, label: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `${label} must be a number of seconds.` };
  if (v < 0) return { ok: false, error: `${label} cannot be negative.` };
  if (v > 1e7) return { ok: false, error: `${label} is too large.` };
  return { ok: true, value: v };
}

/**
 * @param raw  `{mode:"first"}`, `{mode:"full"}` or `{mode:"range", start?, end? | duration?}` (all numbers in seconds)
 * @param sourceSec  real duration of the source audio, or null when the file does not say
 */
export function resolveTrim(raw: unknown, sourceSec: number | null, limits: TrimLimits): TrimResult {
  const req = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const mode = req.mode;

  if (mode === "first") {
    const length = sourceSec === null ? limits.defaultSec : Math.min(limits.defaultSec, sourceSec);
    return {
      ok: true,
      plan: { mode, startSec: 0, lengthSec: length, needsTrim: sourceSec === null || sourceSec > limits.defaultSec + DURATION_EPSILON },
    };
  }

  if (mode === "full") {
    if (sourceSec !== null && sourceSec > limits.maxOutputSec + DURATION_EPSILON)
      return {
        ok: false,
        error: `Full audio is ${fmt(sourceSec)} s long, but the limit for a saved sound is ${fmt(limits.maxOutputSec)} s. Choose a custom range instead.`,
      };
    return { ok: true, plan: { mode, startSec: 0, lengthSec: sourceSec, needsTrim: false } };
  }

  if (mode !== "range") return { ok: false, error: 'Trim mode must be "first", "range" or "full".' };

  const s = req.start === undefined ? ({ ok: true, value: 0 } as const) : num(req.start, "Start time");
  if (!s.ok) return s;
  const start = s.value;

  const hasEnd = req.end !== undefined && req.end !== null;
  const hasDur = req.duration !== undefined && req.duration !== null;
  if (hasEnd === hasDur) return { ok: false, error: "Give either an end time or a length (not both, not neither)." };

  let end: number;
  if (hasEnd) {
    const e = num(req.end, "End time");
    if (!e.ok) return e;
    end = e.value;
  } else {
    const d = num(req.duration, "Length");
    if (!d.ok) return d;
    end = start + d.value;
  }

  if (sourceSec !== null) {
    if (start >= sourceSec - MIN_OUTPUT_SEC)
      return { ok: false, error: `Start time (${fmt(start)} s) is at or past the end of the audio (${fmt(sourceSec)} s).` };
    if (end > sourceSec + DURATION_EPSILON)
      return { ok: false, error: `End time (${fmt(end)} s) is after the end of the audio (${fmt(sourceSec)} s).` };
    end = Math.min(end, sourceSec);
  }
  if (end <= start) return { ok: false, error: "End time must be after the start time." };
  const length = end - start;
  if (length < MIN_OUTPUT_SEC) return { ok: false, error: `The selection is too short (minimum ${MIN_OUTPUT_SEC} s).` };
  if (length > limits.maxOutputSec)
    return { ok: false, error: `The selection is ${fmt(length)} s long. The limit for a saved sound is ${fmt(limits.maxOutputSec)} s.` };

  return {
    ok: true,
    plan: {
      mode,
      startSec: start,
      lengthSec: length,
      needsTrim: sourceSec === null || start > DURATION_EPSILON || end < sourceSec - DURATION_EPSILON,
    },
  };
}
