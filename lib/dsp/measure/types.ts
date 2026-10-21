/** Planar PCM audio, the only input type the measurement layer accepts. */
export interface Pcm {
  sampleRate: number;
  /** One Float32Array per channel, all the same length. */
  channels: Float32Array[];
}

/** A scalar with an explicit unit. Every measurement returns these. */
export interface Quantity<U extends string> {
  value: number;
  unit: U;
}

export const q = <U extends string>(value: number, unit: U): Quantity<U> => ({ value, unit });

export type MeasurementErrorCode =
  | "INVALID_INPUT"
  | "NON_FINITE_SAMPLES"
  | "SILENT_INPUT"
  | "TOO_SHORT"
  | "NOT_STEREO"
  | "NO_NOISE_PRINT"
  | "NOISE_PRINT_INVALID"
  | "NO_SPEECH_ABOVE_NOISE"
  | "INSUFFICIENT_DATA"
  | "INTERNAL";

/** Thrown by every measurement on failure. Measurements never return a fake 0. */
export class MeasurementError extends Error {
  readonly code: MeasurementErrorCode;
  constructor(code: MeasurementErrorCode, message: string) {
    super(message);
    this.name = "MeasurementError";
    this.code = code;
  }
}

/** Per-measurement outcome in an aggregate report: value or explicit failure. */
export type Measured<T> =
  | { ok: true; value: T; elapsedMs: number }
  | { ok: false; error: { code: MeasurementErrorCode; message: string }; elapsedMs: number };

/** dB floor used when a linear value is exactly 0 (digital silence / zero DC). */
export const DB_FLOOR = -200;

export const lin2db = (x: number): number => (x > 0 ? Math.max(20 * Math.log10(x), DB_FLOOR) : DB_FLOOR);
export const pow2db = (x: number): number => (x > 0 ? Math.max(10 * Math.log10(x), DB_FLOOR) : DB_FLOOR);

/** Validates input and throws. Call at the top of every measurement. */
export function assertPcm(pcm: Pcm, minSamples = 1): void {
  if (!pcm || !Array.isArray(pcm.channels) || pcm.channels.length === 0) {
    throw new MeasurementError("INVALID_INPUT", "Audio has no channels.");
  }
  if (!Number.isFinite(pcm.sampleRate) || pcm.sampleRate < 8000 || pcm.sampleRate > 384000) {
    throw new MeasurementError("INVALID_INPUT", `Unsupported sample rate: ${pcm.sampleRate}`);
  }
  const len = pcm.channels[0]!.length;
  for (const ch of pcm.channels) {
    if (ch.length !== len) throw new MeasurementError("INVALID_INPUT", "Channels differ in length.");
    for (let i = 0; i < ch.length; i++) {
      if (!Number.isFinite(ch[i]!)) {
        throw new MeasurementError("NON_FINITE_SAMPLES", `Non-finite sample at index ${i}.`);
      }
    }
  }
  if (len < minSamples) {
    throw new MeasurementError(
      "TOO_SHORT",
      `Audio too short: ${(len / pcm.sampleRate).toFixed(2)}s, need ${(minSamples / pcm.sampleRate).toFixed(2)}s.`,
    );
  }
}

export const durationSec = (pcm: Pcm): number => pcm.channels[0]!.length / pcm.sampleRate;

/** Linear-interpolated percentile of an unsorted array. p in [0,1]. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) throw new MeasurementError("INSUFFICIENT_DATA", "Percentile of empty set.");
  const sorted = Float64Array.from(values).sort();
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}
