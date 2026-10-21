import { forEachPowerSpectrum } from "./fft";
import { type Pcm, type Quantity, MeasurementError, assertPcm, percentile, pow2db, q } from "./types";
import { DEFAULT_THRESHOLDS, type MeasureThresholds } from "./thresholds";

export interface HumCandidate {
  mainsHz: number;
  /** Prominence of each harmonic (index 0 = fundamental) over neighbouring bins, dB. */
  harmonicProminenceDb: number[];
  /** How many harmonics reach the configured prominence. */
  harmonicsPresent: number;
}

export interface HumResult {
  candidates: HumCandidate[];
  /** Candidate with the most harmonics present (ties: highest fundamental prominence). */
  best: HumCandidate;
  /** Prominence of the best candidate's strongest harmonic. */
  peakProminence: Quantity<"dB">;
}

const FFT_SIZE = 16384;
const FLOOR_PERCENTILE = 0.1; // minimum-statistics style: speech is intermittent, hum is not
const MIN_FRAMES = 5;
const NEIGHBOUR_NEAR_HZ = 8;
const NEIGHBOUR_FAR_HZ = 20;

/**
 * Narrowband tonal hum. Builds a per-bin low-percentile spectrum across frames (so speech,
 * which comes and goes, drops out and steady tones remain), then measures how far each
 * mains harmonic sticks out above the median of bins 8-20 Hz either side.
 */
export function measureHum(pcm: Pcm, th: MeasureThresholds["hum"] = DEFAULT_THRESHOLDS.hum): HumResult {
  assertPcm(pcm, FFT_SIZE + (MIN_FRAMES - 1) * (FFT_SIZE / 2));
  const sr = pcm.sampleRate;
  const binHz = sr / FFT_SIZE;
  const nBins = FFT_SIZE / 2 + 1;

  // Mono power-average across channels; frames collected per bin.
  const frames: Float64Array[] = [];
  for (const ch of pcm.channels) {
    forEachPowerSpectrum(ch, FFT_SIZE, FFT_SIZE / 2, (ms, i) => {
      if (ch === pcm.channels[0]) frames.push(Float64Array.from(ms));
      else for (let k = 0; k < nBins; k++) frames[i]![k] = frames[i]![k]! + ms[k]!;
    });
  }
  if (frames.length < MIN_FRAMES) throw new MeasurementError("TOO_SHORT", "Too few frames for hum analysis.");

  const floor = new Float64Array(nBins);
  const column = new Float64Array(frames.length);
  const lowestBin = Math.floor(10 / binHz);
  const highestBin = Math.ceil(((th.mainsHz.length ? Math.max(...th.mainsHz) : 60) * th.harmonics + NEIGHBOUR_FAR_HZ + 5) / binHz);
  for (let k = lowestBin; k <= Math.min(highestBin, nBins - 1); k++) {
    for (let f = 0; f < frames.length; f++) column[f] = frames[f]![k]!;
    floor[k] = percentile(column, FLOOR_PERCENTILE);
  }

  const candidates: HumCandidate[] = th.mainsHz.map((mainsHz) => {
    const prom: number[] = [];
    for (let h = 1; h <= th.harmonics; h++) {
      const f = mainsHz * h;
      if (f + NEIGHBOUR_FAR_HZ >= sr / 2) throw new MeasurementError("INVALID_INPUT", "Sample rate too low for hum harmonics.");
      const centre = Math.round(f / binHz);
      let peak = 0;
      for (let k = centre - 1; k <= centre + 1; k++) peak = Math.max(peak, floor[k]!);
      const neigh: number[] = [];
      for (let k = Math.round((f - NEIGHBOUR_FAR_HZ) / binHz); k <= Math.round((f + NEIGHBOUR_FAR_HZ) / binHz); k++) {
        const d = Math.abs(k * binHz - f);
        if (d >= NEIGHBOUR_NEAR_HZ && d <= NEIGHBOUR_FAR_HZ) neigh.push(floor[k]!);
      }
      const base = percentile(neigh, 0.5);
      if (!(base > 0)) throw new MeasurementError("SILENT_INPUT", "Zero spectral floor near mains frequency; hum undefined.");
      prom.push(pow2db(peak / base));
    }
    return {
      mainsHz,
      harmonicProminenceDb: prom,
      harmonicsPresent: prom.filter((p) => p >= th.harmonicProminenceDb).length,
    };
  });
  const best = candidates.reduce((a, b) =>
    b.harmonicsPresent > a.harmonicsPresent ||
    (b.harmonicsPresent === a.harmonicsPresent && b.harmonicProminenceDb[0]! > a.harmonicProminenceDb[0]!)
      ? b
      : a,
  );
  return { candidates, best, peakProminence: q(Math.max(...best.harmonicProminenceDb), "dB") };
}
