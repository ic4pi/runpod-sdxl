import type { ChainConfig } from "../config";
import { db2lin, msToSamples, pow2dbSafe, smoothCoef } from "./dsp";

export type ExpanderParams = ChainConfig["stages"]["expander"]["params"];

export interface ExpanderResult {
  out: Float32Array;
  /** Linear gain applied per sample, always in [floor, 1]. */
  gain: Float32Array;
  thresholdDbfs: number;
  floorGain: number;
}

/** Static downward-expander curve: gain in dB for an input level `over` dB relative to the threshold. */
export function expanderGainDb(over: number, ratio: number, kneeDb: number, rangeDb: number): number {
  let g: number;
  if (over >= kneeDb / 2) g = 0;
  else if (over <= -kneeDb / 2) g = (ratio - 1) * over;
  else g = (-(ratio - 1) * (kneeDb / 2 - over) ** 2) / (2 * kneeDb);
  return Math.max(g, rangeDb);
}

/**
 * Soft downward expander. It cannot hard-gate: attenuation is floored at `rangeDb`, the gain only
 * closes after `holdMs` and then follows a `releaseMs` exponential, and the knee is quadratic.
 * `thresholdDbfs` is chosen by the caller (relative to the noise print, or absolute).
 */
export function applyExpander(x: Float32Array, sampleRate: number, p: ExpanderParams, thresholdDbfs: number): ExpanderResult {
  const n = x.length;
  const out = new Float32Array(n);
  const gain = new Float32Array(n);
  const det = smoothCoef(p.detectorMs, sampleRate);
  const aOpen = smoothCoef(p.attackMs, sampleRate);
  const aClose = smoothCoef(p.releaseMs, sampleRate);
  const holdSamples = msToSamples(p.holdMs, sampleRate);
  const floorGain = db2lin(p.rangeDb);
  const deadband = db2lin(p.openDeadbandDb);

  let ms = 0;
  let g = 1;
  let hold = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i]!;
    ms = det * ms + (1 - det) * v * v;
    const over = pow2dbSafe(ms) - thresholdDbfs;
    const target = db2lin(expanderGainDb(over, p.ratio, p.kneeDb, p.rangeDb));
    if (target > g * deadband) {
      g = target + (g - target) * aOpen;
      hold = holdSamples;
    } else if (target >= g) {
      hold = holdSamples; // within the deadband: keep the gain, keep the hold armed
    } else if (hold > 0) {
      hold--;
    } else {
      g = target + (g - target) * aClose;
    }
    if (g < floorGain) g = floorGain;
    if (g > 1) g = 1;
    gain[i] = g;
    out[i] = v * g;
  }
  return { out, gain, thresholdDbfs, floorGain };
}
