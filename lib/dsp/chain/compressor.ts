import type { ChainConfig } from "../config";
import { db2lin, lin2dbSafe, smoothCoef } from "./dsp";

export type CompressorParams = ChainConfig["stages"]["compressor"]["params"];

export interface CompressorResult {
  out: Float32Array;
  /** Gain reduction per sample in dB (>= 0), before make-up. */
  reductionDb: Float32Array;
  maxReductionDb: number;
}

/** Feed-forward peak compressor, soft knee, ballistics on the gain reduction in dB. */
export function applyCompressor(x: Float32Array, sampleRate: number, p: CompressorParams): CompressorResult {
  const aAtt = smoothCoef(p.attackMs, sampleRate);
  const aRel = smoothCoef(p.releaseMs, sampleRate);
  const slope = 1 - 1 / p.ratio;
  const makeup = db2lin(p.makeupDb);
  const n = x.length;
  const out = new Float32Array(n);
  const reductionDb = new Float32Array(n);
  let gr = 0;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const over = lin2dbSafe(Math.abs(x[i]!)) - p.thresholdDb;
    let target: number;
    if (over <= -p.kneeDb / 2) target = 0;
    else if (over >= p.kneeDb / 2) target = over * slope;
    else target = (slope * (over + p.kneeDb / 2) ** 2) / (2 * p.kneeDb);
    const c = target > gr ? aAtt : aRel;
    gr = c * gr + (1 - c) * target;
    reductionDb[i] = gr;
    if (gr > worst) worst = gr;
    out[i] = x[i]! * db2lin(-gr) * makeup;
  }
  return { out, reductionDb, maxReductionDb: worst };
}
