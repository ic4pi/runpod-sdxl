import type { MeasureReport } from "../measure";

export interface Level {
  value: number;
  method: "LUFS" | "RMS";
}

/** Integrated LUFS when available (needs >= 3 s), otherwise active-block RMS. Throws if neither can be measured. */
export function levelFromReport(r: MeasureReport): Level {
  if (r.loudness.ok) return { value: r.loudness.value.integrated.value, method: "LUFS" };
  if (r.crest.ok) return { value: r.crest.value.activeRms.value, method: "RMS" };
  throw new Error(`Cannot level-match: loudness failed (${r.loudness.error.message}) and RMS failed (${r.crest.ok ? "" : r.crest.error.message}).`);
}

export interface MatchGains {
  originalGainDb: number;
  processedGainDb: number;
  method: Level["method"];
}

/** The louder side is turned down to the quieter one, so level matching never adds gain (no clipping surprises). */
export function levelMatchGains(original: Level, processed: Level): MatchGains {
  if (original.method !== processed.method) {
    throw new Error(`Cannot level-match across methods (${original.method} vs ${processed.method}).`);
  }
  const diff = processed.value - original.value; // >0: processed is louder
  return diff > 0
    ? { originalGainDb: 0, processedGainDb: -diff, method: original.method }
    : { originalGainDb: diff, processedGainDb: 0, method: original.method };
}
