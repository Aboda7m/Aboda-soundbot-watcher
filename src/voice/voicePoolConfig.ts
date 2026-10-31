import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface VoicePoolConfig {
  scheduler: {
    waitMs: number;
    recordingPreferredWorker: string;
  };
}

const DEFAULTS: VoicePoolConfig = {
  scheduler: { waitMs: 60_000, recordingPreferredWorker: "worker-2" },
};

export function loadVoicePoolConfig(file = resolve("./voice-pool.json")): VoicePoolConfig {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<VoicePoolConfig>;
    const scheduler = raw.scheduler;
    const waitMs = scheduler?.waitMs;
    const preferred = scheduler?.recordingPreferredWorker;
    return {
      scheduler: {
        waitMs: Number.isInteger(waitMs) && waitMs! >= 1000 && waitMs! <= 300_000 ? waitMs! : DEFAULTS.scheduler.waitMs,
        recordingPreferredWorker: typeof preferred === "string" && /^worker-[12]$/.test(preferred) ? preferred : DEFAULTS.scheduler.recordingPreferredWorker,
      },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Could not read voice-pool.json; using defaults: ${(err as Error).message}`);
    return DEFAULTS;
  }
}
