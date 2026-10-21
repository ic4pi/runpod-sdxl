import { type Pcm, type Quantity, MeasurementError, assertPcm, lin2db, q } from "./types";

/**
 * True peak via 4x oversampling. Phase 0 of the 4x stream is the original sample;
 * phases 1-3 are 12-tap Kaiser-windowed-sinc interpolators (beta 8).
 * NOTE: not the exact BS.1770-4 Annex 2 coefficient table (see DECISIONS.md).
 */
export interface TruePeakResult {
  truePeak: Quantity<"dBTP">;
  samplePeak: Quantity<"dBFS">;
  perChannelTruePeak: Quantity<"dBTP">[];
}

const OVERSAMPLE = 4;
const TAPS = 12;
const LEFT = 5; // taps cover x[n-5 .. n+6]
const KAISER_BETA = 8;

function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-14 * sum) break;
  }
  return sum;
}

function buildPhases(): Float64Array[] {
  const phases: Float64Array[] = [];
  for (let p = 1; p < OVERSAMPLE; p++) {
    const frac = p / OVERSAMPLE;
    const h = new Float64Array(TAPS);
    let sum = 0;
    for (let t = 0; t < TAPS; t++) {
      const d = t - LEFT - frac; // distance from tap sample to target instant
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const r = d / (TAPS / 2);
      const w = Math.abs(r) >= 1 ? 0 : bessel0(KAISER_BETA * Math.sqrt(1 - r * r)) / bessel0(KAISER_BETA);
      h[t] = sinc * w;
      sum += h[t]!;
    }
    for (let t = 0; t < TAPS; t++) h[t] = h[t]! / sum; // unity DC gain
    phases.push(h);
  }
  return phases;
}

const PHASES = buildPhases();

/**
 * Walks the 4x oversampled stream of one channel in time order, calling
 * `visit(absValue, index4x)` for every oversampled sample.
 */
export function scanOversampled(x: Float32Array, visit: (absValue: number, index4x: number) => void): void {
  const len = x.length;
  for (let n = 0; n < len; n++) {
    visit(Math.abs(x[n]!), n * OVERSAMPLE);
    for (let p = 1; p < OVERSAMPLE; p++) {
      const h = PHASES[p - 1]!;
      let y = 0;
      for (let t = 0; t < TAPS; t++) {
        const idx = n + t - LEFT;
        if (idx >= 0 && idx < len) y += x[idx]! * h[t]!;
      }
      visit(Math.abs(y), n * OVERSAMPLE + p);
    }
  }
}

export function measureTruePeak(pcm: Pcm): TruePeakResult {
  assertPcm(pcm);
  let samplePeak = 0;
  let truePeak = 0;
  const perChannel: Quantity<"dBTP">[] = [];
  for (const ch of pcm.channels) {
    let chPeak = 0;
    scanOversampled(ch, (v) => {
      if (v > chPeak) chPeak = v;
    });
    for (let i = 0; i < ch.length; i++) samplePeak = Math.max(samplePeak, Math.abs(ch[i]!));
    truePeak = Math.max(truePeak, chPeak);
    perChannel.push(q(lin2db(chPeak), "dBTP"));
  }
  if (truePeak === 0) throw new MeasurementError("SILENT_INPUT", "All samples are zero; true peak undefined.");
  return {
    truePeak: q(lin2db(truePeak), "dBTP"),
    samplePeak: q(lin2db(samplePeak), "dBFS"),
    perChannelTruePeak: perChannel,
  };
}
