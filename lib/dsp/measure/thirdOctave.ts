import { forEachPowerSpectrum } from "./fft";
import { type Pcm, type Quantity, MeasurementError, assertPcm, pow2db, q } from "./types";

/**
 * Third-octave band levels (base-10, IEC 61260 centres 25 Hz - 16 kHz) from a Welch-averaged
 * Hann-windowed FFT (16384 pts, 50% overlap), power-averaged across channels and frames.
 * Level unit: dBFS where a full-scale sine reads -3.01 dBFS (mean-square basis).
 */
export interface ThirdOctaveResult {
  bands: { centerHz: number; lowHz: number; highHz: number; level: Quantity<"dBFS"> }[];
  total: Quantity<"dBFS">;
  frameCount: number;
}

const FFT_SIZE = 16384;
const FIRST_INDEX = -16; // 10^(-16/10) * 1000 = 25.12 Hz
const LAST_INDEX = 12; // 15.85 kHz

export function measureThirdOctave(pcm: Pcm): ThirdOctaveResult {
  assertPcm(pcm, FFT_SIZE);
  const sr = pcm.sampleRate;
  const binHz = sr / FFT_SIZE;
  const edges: { c: number; lo: number; hi: number }[] = [];
  for (let n = FIRST_INDEX; n <= LAST_INDEX; n++) {
    const c = 1000 * Math.pow(10, n / 10);
    const lo = c * Math.pow(10, -0.05);
    const hi = c * Math.pow(10, 0.05);
    if (hi < sr / 2) edges.push({ c, lo, hi });
  }
  const acc = new Float64Array(edges.length);
  let totalAcc = 0;
  let frames = 0;
  for (const ch of pcm.channels) {
    frames = forEachPowerSpectrum(ch, FFT_SIZE, FFT_SIZE / 2, (ms) => {
      for (let b = 0; b < edges.length; b++) {
        const kLo = Math.ceil(edges[b]!.lo / binHz);
        const kHi = Math.ceil(edges[b]!.hi / binHz); // exclusive
        let s = 0;
        for (let k = kLo; k < kHi; k++) s += ms[k]!;
        acc[b] = acc[b]! + s;
      }
      for (let k = 0; k < ms.length; k++) totalAcc += ms[k]!;
    });
  }
  if (frames === 0) throw new MeasurementError("TOO_SHORT", "No full FFT frame available.");
  const norm = 1 / (frames * pcm.channels.length);
  if (totalAcc === 0) throw new MeasurementError("SILENT_INPUT", "All samples are zero; spectrum undefined.");
  return {
    bands: edges.map((e, i) => ({
      centerHz: e.c,
      lowHz: e.lo,
      highHz: e.hi,
      level: q(pow2db(acc[i]! * norm), "dBFS"),
    })),
    total: q(pow2db(totalAcc * norm), "dBFS"),
    frameCount: frames,
  };
}
