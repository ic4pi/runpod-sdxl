import type { ChainConfig } from "../config";
import { applyBiquadZeroPhase, lowpass } from "../measure/biquad";
import { computeLfFrames } from "../measure/plosive";
import { percentile } from "../measure/types";
import { db2lin, msToSamples, pow2dbSafe } from "./dsp";
import type { ConfirmedPlosives, PlosiveCandidate } from "./types";

export type DeplosiveParams = ChainConfig["stages"]["deplosive"]["params"];

/**
 * Detect candidate pops: LF-band (20-80 Hz) frames that (a) are loud enough, (b) hold a large share
 * of the energy, (c) stand well above the file's median LF level, and (d) arrive as a transient:
 * LF level rises sharply over the preceding window. When the file is clipped, (d) must rise by
 * `clippedExtraRiseDb` more: one-sided clipping creates slow DC-like LF shifts that mimic pops.
 * Detection NEVER modifies audio; the result goes to a confirmation step.
 */
export function detectPlosives(x: Float32Array, sampleRate: number, p: DeplosiveParams["detect"], clipped: boolean): PlosiveCandidate[] {
  const frameSec = p.frameMs / 1000;
  const { lf, total } = computeLfFrames({ sampleRate, channels: [x] }, p, frameSec);
  const nFrames = lf.length;
  const settle = Math.ceil(p.settleSec / frameSec);
  if (nFrames <= settle) return [];
  const lfDb = Array.from(lf, pow2dbSafe);
  const median = percentile(lfDb.slice(settle), 0.5);
  const riseNeeded = p.onsetRiseDb + (clipped ? p.clippedExtraRiseDb : 0);
  const minFrames = Math.ceil(p.minDurationMs / p.frameMs);
  const maxFrames = Math.floor(p.maxDurationMs / p.frameMs);
  const win = Math.max(1, Math.round(p.onsetWindowMs / p.frameMs));

  const out: PlosiveCandidate[] = [];
  let start = -1;
  let peak = -Infinity;
  let fracAtPeak = 0;
  const close = (end: number) => {
    const n = end - start;
    if (start >= 0 && n >= minFrames && n <= maxFrames && start - win >= settle) {
      let prev = 0;
      for (let k = 1; k <= win; k++) prev += lfDb[start - k]! / win;
      const first = Math.max(lfDb[start]!, lfDb[Math.min(start + 1, nFrames - 1)]!);
      const rise = first - prev;
      if (rise >= riseNeeded) {
        out.push({
          id: out.length,
          startSec: start * frameSec,
          durationMs: n * p.frameMs,
          lfPeakDbfs: peak,
          lfFractionDb: fracAtPeak,
          onsetRiseDb: rise,
          overMedianDb: peak - median,
        });
      }
    }
    start = -1;
    peak = -Infinity;
  };
  for (let f = settle; f < nFrames; f++) {
    const frac = pow2dbSafe(lf[f]! / Math.max(total[f]!, 1e-30));
    const hit = lfDb[f]! >= p.minLfDbfs && frac >= p.minLfFractionDb && lfDb[f]! >= median + p.burstOverMedianDb;
    if (hit) {
      if (start < 0) start = f;
      if (lfDb[f]! > peak) {
        peak = lfDb[f]!;
        fracAtPeak = frac;
      }
    } else if (start >= 0) {
      close(f);
    }
  }
  if (start >= 0) close(nFrames);
  return out;
}

export interface DeplosiveResult {
  out: Float32Array;
  /** Shelf gain curve (1 = untouched). */
  gain: Float32Array;
  appliedEvents: number;
}

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Time-varying low-shelf dip below `shelfHz`: out = x - (1 - g(t)) * lowpass(x). g ramps down to
 * `depthDb` around each CONFIRMED event only. The low-pass is zero-phase (offline), so the subtraction cancels cleanly instead of smearing. Takes `ConfirmedPlosives`, so it cannot be called on raw detections.
 */
export function applyDeplosive(x: Float32Array, sampleRate: number, confirmed: ConfirmedPlosives, p: DeplosiveParams["apply"]): DeplosiveResult {
  const n = x.length;
  const gain = new Float32Array(n).fill(1);
  const out = Float32Array.from(x);
  if (confirmed.events.length === 0) return { out, gain, appliedEvents: 0 };
  const lp = applyBiquadZeroPhase(x, lowpass(p.shelfHz, p.lowpassQ, sampleRate));
  const gMin = db2lin(p.depthDb);
  const att = Math.max(1, msToSamples(p.attackMs, sampleRate));
  const rel = Math.max(1, msToSamples(p.releaseMs, sampleRate));
  for (const e of confirmed.events) {
    const a = Math.max(0, Math.round(e.startSec * sampleRate) - msToSamples(p.padBeforeMs, sampleRate));
    const b = Math.min(n - 1, Math.round(e.startSec * sampleRate) + msToSamples(e.durationMs + p.padAfterMs, sampleRate));
    for (let i = a; i <= b; i++) {
      const w = smoothstep(Math.min((i - a) / att, (b - i) / rel, 1));
      const g = 1 - (1 - gMin) * w;
      if (g < gain[i]!) gain[i] = g;
    }
  }
  for (let i = 0; i < n; i++) if (gain[i]! < 1) out[i] = x[i]! - (1 - gain[i]!) * lp[i]!;
  return { out, gain, appliedEvents: confirmed.events.length };
}
