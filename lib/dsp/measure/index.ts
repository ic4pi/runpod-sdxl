import { measureClipping, type ClippingResult } from "./clipping";
import { measureCorrelation, type CorrelationResult } from "./correlation";
import { measureCrest, type CrestResult } from "./crest";
import { measureDcOffset, type DcOffsetResult } from "./dcOffset";
import { measureHum, type HumResult } from "./hum";
import { measureLoudness, type LoudnessResult } from "./loudness";
import { measureNoise, type NoiseResult } from "./noise";
import { measurePlosives, type PlosiveResult } from "./plosive";
import { measureThirdOctave, type ThirdOctaveResult } from "./thirdOctave";
import { DEFAULT_THRESHOLDS, type MeasureThresholds } from "./thresholds";
import { measureTruePeak, type TruePeakResult } from "./truePeak";
import { MeasurementError, type Measured, type Pcm } from "./types";

export interface MeasureReport {
  loudness: Measured<LoudnessResult>;
  truePeak: Measured<TruePeakResult>;
  thirdOctave: Measured<ThirdOctaveResult>;
  crest: Measured<CrestResult>;
  correlation: Measured<CorrelationResult>;
  noise: Measured<NoiseResult>;
  clipping: Measured<ClippingResult>;
  dcOffset: Measured<DcOffsetResult>;
  hum: Measured<HumResult>;
  plosive: Measured<PlosiveResult>;
  totalElapsedMs: number;
}

function run<T>(fn: () => T): Measured<T> {
  const t0 = performance.now();
  try {
    const value = fn();
    return { ok: true, value, elapsedMs: performance.now() - t0 };
  } catch (e) {
    const err =
      e instanceof MeasurementError
        ? { code: e.code, message: e.message }
        : { code: "INTERNAL" as const, message: e instanceof Error ? e.message : String(e) };
    return { ok: false, error: err, elapsedMs: performance.now() - t0 };
  }
}

/**
 * Runs every measurement. A failing measurement is reported as `{ ok: false, error }`,
 * never as a zero, and never aborts the others.
 */
export function measureAll(
  pcm: Pcm,
  noisePrint?: Pcm | null,
  th: MeasureThresholds = DEFAULT_THRESHOLDS,
): MeasureReport {
  const t0 = performance.now();
  const report = {
    loudness: run(() => measureLoudness(pcm)),
    truePeak: run(() => measureTruePeak(pcm)),
    thirdOctave: run(() => measureThirdOctave(pcm)),
    crest: run(() => measureCrest(pcm, th.crest)),
    correlation: run(() => measureCorrelation(pcm)),
    noise: run(() => measureNoise(pcm, noisePrint, th.noise)),
    clipping: run(() => measureClipping(pcm, th.clipping)),
    dcOffset: run(() => measureDcOffset(pcm)),
    hum: run(() => measureHum(pcm, th.hum)),
    plosive: run(() => measurePlosives(pcm, th.plosive)),
  };
  return { ...report, totalElapsedMs: performance.now() - t0 };
}

export * from "./types";
export { DEFAULT_THRESHOLDS, type MeasureThresholds } from "./thresholds";
export { runDetectors, DETECTOR_IDS, type DetectorId, type DetectorVerdict } from "./detectors";
