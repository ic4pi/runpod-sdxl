import type { NoisePrintParams } from "../config";
import { percentile } from "../measure/types";
import { pow2dbSafe } from "./dsp";
import type { NoisePrintVerdict, PrintRejection } from "./types";

/**
 * Noise-print validation. A print is accepted only if it passes ALL layers (fail-closed):
 *  1 length   : duration within [minSec, maxSec]; not digital silence.
 *  2 energy   : 100 ms block RMS (DC removed) max-min <= maxBlockSpreadDb. Catches speech with pauses, big level changes.
 *  3 bump     : 10 ms frame RMS max vs median <= maxBumpOverMedianDb. Catches knocks, pops, single words.
 *  4 vad      : RNNoise voice-activity probability per 10 ms; fraction >= threshold must be <= maxSpeechFraction.
 *               Catches sustained speech that has no level change. Needs the RNNoise engine; if the caller supplies no
 *               VAD values while enabled, the print is rejected (fail-closed).
 *  5 harmonic : normalised autocorrelation of pre-emphasised 40 ms frames; local maxima in the F0 range
 *               (80-400 Hz) at lags that are not mains multiples; fraction of frames >= minCorrelation must be
 *               <= maxVoicedFraction. Catches steady voiced sound that VAD misses, without rejecting 50/60 Hz hum.
 * Layers 2-3 use only energy, 4 is a trained VAD, 5 is a periodicity test. None needs a transcript.
 */
export function validateNoisePrint(
  print: Float32Array,
  sampleRate: number,
  p: NoisePrintParams,
  /** RNNoise per-frame VAD probabilities for `print` (10 ms frames), or null if unavailable. */
  vad: Float32Array | null,
): NoisePrintVerdict {
  const rejections: PrintRejection[] = [];
  const durationSec = print.length / sampleRate;
  const metrics: NoisePrintVerdict["metrics"] = {
    durationSec,
    blockSpreadDb: null,
    bumpOverMedianDb: null,
    vadSpeechFraction: null,
    voicedFraction: null,
  };
  const reject = (layer: PrintRejection["layer"], message: string, value: number, limit: number) =>
    rejections.push({ layer, message, value, limit });

  if (durationSec < p.minSec || durationSec > p.maxSec) {
    reject("length", `Noise print is ${durationSec.toFixed(2)} s; allowed ${p.minSec}-${p.maxSec} s.`, durationSec, durationSec < p.minSec ? p.minSec : p.maxSec);
    return { ok: false, rejections, noiseFloorDbfs: null, metrics };
  }

  let mean = 0;
  for (let i = 0; i < print.length; i++) mean += print[i]!;
  mean /= print.length;
  const x = new Float64Array(print.length);
  let sumSq = 0;
  for (let i = 0; i < print.length; i++) {
    x[i] = print[i]! - mean;
    sumSq += x[i]! * x[i]!;
  }
  if (sumSq === 0) {
    reject("silence", "Noise print is digital silence.", 0, 0);
    return { ok: false, rejections, noiseFloorDbfs: null, metrics };
  }
  const noiseFloorDbfs = pow2dbSafe(sumSq / x.length);

  const frameDb = (sec: number): number[] => {
    const len = Math.round(sec * sampleRate);
    const nb = Math.floor(x.length / len);
    const out: number[] = [];
    for (let b = 0; b < nb; b++) {
      let s = 0;
      for (let i = b * len; i < (b + 1) * len; i++) s += x[i]! * x[i]!;
      out.push(pow2dbSafe(s / len));
    }
    return out;
  };

  // 2 energy stability
  const blocks = frameDb(p.blockSec);
  const spread = Math.max(...blocks) - Math.min(...blocks);
  metrics.blockSpreadDb = spread;
  if (spread > p.maxBlockSpreadDb) {
    reject("energy", `Level varies by ${spread.toFixed(1)} dB between blocks (limit ${p.maxBlockSpreadDb} dB): likely speech or a level change.`, spread, p.maxBlockSpreadDb);
  }

  // 3 bumps
  const fine = frameDb(p.fineFrameSec);
  const bump = Math.max(...fine) - percentile(fine, 0.5);
  metrics.bumpOverMedianDb = bump;
  if (bump > p.maxBumpOverMedianDb) {
    reject("bump", `A ${p.fineFrameSec * 1000} ms frame is ${bump.toFixed(1)} dB above the median (limit ${p.maxBumpOverMedianDb} dB): likely a knock or word.`, bump, p.maxBumpOverMedianDb);
  }

  // 4 VAD
  if (p.vad.enabled) {
    if (!vad || vad.length === 0) {
      reject("vad", "Voice-activity detector unavailable; print cannot be verified as speech-free.", NaN, p.vad.maxSpeechFraction);
    } else {
      let hits = 0;
      for (const v of vad) if (v >= p.vad.threshold) hits++;
      const frac = hits / vad.length;
      metrics.vadSpeechFraction = frac;
      if (frac > p.vad.maxSpeechFraction) {
        reject("vad", `${(frac * 100).toFixed(0)}% of frames look like speech to the voice detector (limit ${(p.vad.maxSpeechFraction * 100).toFixed(0)}%).`, frac, p.vad.maxSpeechFraction);
      }
    }
  }

  // 5 harmonic / voiced periodicity
  if (p.harmonic.enabled) {
    const h = p.harmonic;
    const e = new Float64Array(x.length);
    for (let i = 1; i < x.length; i++) e[i] = x[i]! - h.preEmphasis * x[i - 1]!;
    const lagMin = Math.floor(sampleRate / h.f0MaxHz);
    const lagMax = Math.ceil(sampleRate / h.f0MinHz);
    const allowed: number[] = [];
    for (let l = lagMin; l <= lagMax; l++) {
      const f = sampleRate / l;
      const isMains = h.mainsHz.some((m) => {
        const k = Math.round(f / m);
        return k >= 1 && Math.abs(f - k * m) <= h.mainsToleranceHz;
      });
      if (!isMains) allowed.push(l);
    }
    const flen = Math.round(h.frameSec * sampleRate);
    const minMs = Math.pow(10, h.minFrameDbfs / 10);
    let tested = 0;
    let voiced = 0;
    for (let start = 0; start + flen + lagMax + 1 <= e.length; start += flen) {
      let e0 = 0;
      for (let i = 0; i < flen; i++) e0 += e[start + i]! * e[start + i]!;
      if (e0 / flen < minMs) continue;
      tested++;
      const r = new Float64Array(lagMax + 2);
      for (let l = lagMin - 1; l <= lagMax + 1; l++) {
        let c = 0;
        let e1 = 0;
        for (let i = 0; i < flen; i++) {
          c += e[start + i]! * e[start + i + l]!;
          e1 += e[start + i + l]! * e[start + i + l]!;
        }
        r[l] = c / Math.sqrt(e0 * e1 + 1e-30);
      }
      let best = 0;
      for (const l of allowed) {
        if (r[l]! > r[l - 1]! && r[l]! >= r[l + 1]! && r[l]! > best) best = r[l]!;
      }
      if (best >= h.minCorrelation) voiced++;
    }
    const frac = tested > 0 ? voiced / tested : 0;
    metrics.voicedFraction = frac;
    if (frac > h.maxVoicedFraction) {
      reject("harmonic", `${(frac * 100).toFixed(0)}% of frames are periodic like a voice (limit ${(h.maxVoicedFraction * 100).toFixed(0)}%).`, frac, h.maxVoicedFraction);
    }
  }

  return { ok: rejections.length === 0, rejections, noiseFloorDbfs, metrics };
}
