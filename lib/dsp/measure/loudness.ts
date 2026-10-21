import { applyBiquad, type Biquad } from "./biquad";
import { type Pcm, type Quantity, MeasurementError, assertPcm, percentile, q } from "./types";

/**
 * ITU-R BS.1770-4 / EBU R128 loudness: integrated LUFS, short-term LUFS, LRA (EBU Tech 3342).
 * K-weighting coefficients are derived per sample rate from the standard's analog prototype.
 * All channels get weight 1.0 (mono / L-R only; no surround weights).
 */
export interface LoudnessResult {
  integrated: Quantity<"LUFS">;
  /** Loudest 3 s window. */
  shortTermMax: Quantity<"LUFS">;
  /** Short-term series, one value per 100 ms hop (window = 3 s). */
  shortTermTimeline: { hopSec: number; lufs: number[] };
  momentaryMax: Quantity<"LUFS">;
  lra: Quantity<"LU">;
  /** 10th / 95th percentile short-term loudness that define the LRA. */
  lraBounds: { lowLufs: number; highLufs: number };
}

const SUB_SEC = 0.1; // 100 ms sub-blocks; 400 ms momentary = 4, 3 s short-term = 30
const ABS_GATE_LUFS = -70;
const REL_GATE_INTEGRATED_LU = -10;
const REL_GATE_LRA_LU = -20;

function kWeightingStages(sr: number): [Biquad, Biquad] {
  // Stage 1: high shelf (head model)
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  K = Math.tan((Math.PI * f1) / sr);
  a0 = 1 + K / Q1 + K * K;
  const rlb: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q1 + K * K) / a0,
  };
  return [shelf, rlb];
}

const toLufs = (meanSquare: number): number => -0.691 + 10 * Math.log10(meanSquare);

export function measureLoudness(pcm: Pcm): LoudnessResult {
  assertPcm(pcm);
  const sr = pcm.sampleRate;
  const sub = Math.round(SUB_SEC * sr);
  const len = pcm.channels[0]!.length;
  const nSub = Math.floor(len / sub);
  if (nSub < 30) {
    throw new MeasurementError(
      "TOO_SHORT",
      `Loudness needs >= 3 s of audio for short-term/LRA; got ${(len / sr).toFixed(2)} s.`,
    );
  }

  const [shelf, rlb] = kWeightingStages(sr);
  const z = new Float64Array(nSub); // channel-summed mean-square per 100 ms sub-block
  for (const ch of pcm.channels) {
    const w = applyBiquad(applyBiquad(ch, shelf), rlb);
    for (let b = 0; b < nSub; b++) {
      let s = 0;
      for (let i = b * sub, end = i + sub; i < end; i++) s += w[i]! * w[i]!;
      z[b] = z[b]! + s / sub;
    }
  }

  // Sliding means over sub-blocks via prefix sums.
  const prefix = new Float64Array(nSub + 1);
  for (let i = 0; i < nSub; i++) prefix[i + 1] = prefix[i]! + z[i]!;
  const windowMs = (count: number): Float64Array => {
    const out = new Float64Array(nSub - count + 1);
    for (let i = 0; i < out.length; i++) out[i] = (prefix[i + count]! - prefix[i]!) / count;
    return out;
  };
  const momentary = windowMs(4);
  const shortTerm = windowMs(30);

  // Integrated: abs gate, then relative gate -10 LU, power-domain means.
  const absPass = Array.from(momentary).filter((ms) => ms > 0 && toLufs(ms) > ABS_GATE_LUFS);
  if (absPass.length === 0) {
    throw new MeasurementError("SILENT_INPUT", "No 400 ms block exceeds the -70 LUFS absolute gate.");
  }
  const absMean = absPass.reduce((a, b) => a + b, 0) / absPass.length;
  const relGate = toLufs(absMean) + REL_GATE_INTEGRATED_LU;
  const relPass = absPass.filter((ms) => toLufs(ms) > relGate);
  const integrated = toLufs(relPass.reduce((a, b) => a + b, 0) / relPass.length);

  // LRA: short-term values, abs gate, relative gate -20 LU, P95 - P10.
  const stLufs = Array.from(shortTerm, (ms) => (ms > 0 ? toLufs(ms) : -Infinity));
  const stAbs = stLufs.filter((l) => l > ABS_GATE_LUFS);
  if (stAbs.length < 2) {
    throw new MeasurementError("INSUFFICIENT_DATA", "Fewer than 2 short-term values above the absolute gate; LRA undefined.");
  }
  const stMeanMs = stAbs.reduce((a, l) => a + Math.pow(10, (l + 0.691) / 10), 0) / stAbs.length;
  const stRel = toLufs(stMeanMs) + REL_GATE_LRA_LU;
  const stGated = stAbs.filter((l) => l > stRel);
  if (stGated.length < 2) {
    throw new MeasurementError("INSUFFICIENT_DATA", "Fewer than 2 short-term values after relative gate; LRA undefined.");
  }
  const high = percentile(stGated, 0.95);
  const low = percentile(stGated, 0.1);

  let momMax = -Infinity;
  for (const ms of momentary) if (ms > 0) momMax = Math.max(momMax, toLufs(ms));
  let stMax = -Infinity;
  for (const l of stLufs) stMax = Math.max(stMax, l);

  return {
    integrated: q(integrated, "LUFS"),
    shortTermMax: q(stMax, "LUFS"),
    shortTermTimeline: { hopSec: SUB_SEC, lufs: stLufs },
    momentaryMax: q(momMax, "LUFS"),
    lra: q(high - low, "LU"),
    lraBounds: { lowLufs: low, highLufs: high },
  };
}
