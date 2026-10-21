import type { ChainConfig } from "../config";
import { applyBiquad, applyBiquadZeroPhase, highpass, lowpass } from "../measure/biquad";
import { db2lin, lin2dbSafe, smoothCoef } from "./dsp";

export type DeessParams = ChainConfig["stages"]["deess"]["params"];

export interface DeessResult {
  out: Float32Array;
  /** Linear gain applied to the 5-9 kHz band per sample (1 = untouched). */
  gain: Float32Array;
  maxReductionDb: number;
}

/**
 * De-esser as a dynamic high shelf. Sidechain = the 5-9 kHz band-passed signal; its peak envelope drives a
 * compressor-style curve. The part above `shelfHz` (x minus a zero-phase low-pass, so no phase smear) is
 * turned down: out = x - (1 - g) * high(x). Content below the shelf is never touched.
 * When g == 1 the output equals the input exactly.
 */
export function applyDeess(x: Float32Array, sampleRate: number, p: DeessParams): DeessResult {
  const side = applyBiquad(applyBiquad(x, highpass(p.bandLowHz, p.filterQ, sampleRate)), lowpass(p.bandHighHz, p.filterQ, sampleRate));
  const low = applyBiquadZeroPhase(x, lowpass(p.shelfHz, p.filterQ, sampleRate));
  const aAtt = smoothCoef(p.attackMs, sampleRate);
  const aRel = smoothCoef(p.releaseMs, sampleRate);
  const slope = 1 - 1 / p.ratio;
  const n = x.length;
  const out = new Float32Array(n);
  const gain = new Float32Array(n);
  let env = 0;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(side[i]!);
    const c = a > env ? aAtt : aRel;
    env = c * env + (1 - c) * a;
    const over = lin2dbSafe(env) - p.thresholdDbfs;
    let reductionDb = over > 0 ? over * slope : 0;
    if (reductionDb > -p.maxReductionDb) reductionDb = -p.maxReductionDb;
    const g = reductionDb > 0 ? db2lin(-reductionDb) : 1;
    if (reductionDb > worst) worst = reductionDb;
    gain[i] = g;
    out[i] = x[i]! - (1 - g) * (x[i]! - low[i]!);
  }
  return { out, gain, maxReductionDb: worst };
}
