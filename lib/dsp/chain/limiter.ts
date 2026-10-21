import type { ChainConfig } from "../config";
import { scanOversampled } from "../measure/truePeak";
import { db2lin, msToSamples, smoothCoef } from "./dsp";

export type LimiterParams = ChainConfig["stages"]["limiter"]["params"];

export interface LimiterResult {
  out: Float32Array;
  gain: Float32Array;
  maxReductionDb: number;
}

/**
 * Look-ahead limiter driven by the 4x-oversampled peak (same interpolator as the true-peak measurement).
 * Offline, so the look-ahead is non-causal: required gain -> sliding minimum over the look-ahead window ->
 * moving average (guarantees gain <= required at every sample) -> exponential release (min with the average,
 * so the ceiling is never violated).
 */
export function applyLimiter(x: Float32Array, sampleRate: number, p: LimiterParams): LimiterResult {
  const n = x.length;
  const ceiling = db2lin(p.ceilingDbtp);
  const look = Math.max(1, msToSamples(p.lookaheadMs, sampleRate));
  const rel = smoothCoef(p.releaseMs, sampleRate);

  const peak = new Float32Array(n);
  scanOversampled(x, (v, idx4) => {
    const i = idx4 >> 2;
    if (v > peak[i]!) peak[i] = v;
  });
  const req = new Float64Array(n);
  for (let i = 0; i < n; i++) req[i] = peak[i]! > ceiling ? ceiling / peak[i]! : 1;

  // sliding minimum over [i, i + look]
  const gMin = new Float64Array(n);
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && req[dq[tail - 1]!]! >= req[i]!) tail--;
    dq[tail++] = i;
    while (dq[head]! > i + look) head++;
    gMin[i] = req[dq[head]!]!;
  }

  // moving average over [i - look, i]
  const gAvg = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += gMin[i]!;
    if (i - look - 1 >= 0) sum -= gMin[i - look - 1]!;
    const count = Math.min(i, look) + 1;
    // before the first full window, pad with the first value so the start is not pulled up to 1
    const pad = look + 1 - count;
    gAvg[i] = (sum + pad * gMin[0]!) / (look + 1);
  }

  const out = new Float32Array(n);
  const gain = new Float32Array(n);
  let g = 1;
  let worst = 1;
  for (let i = 0; i < n; i++) {
    const recover = g + (1 - g) * (1 - rel);
    g = Math.min(gAvg[i]!, recover);
    if (g < worst) worst = g;
    gain[i] = g;
    out[i] = x[i]! * g;
  }
  return { out, gain, maxReductionDb: -20 * Math.log10(worst) };
}
