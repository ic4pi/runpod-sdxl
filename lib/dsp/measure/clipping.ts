import { scanOversampled } from "./truePeak";
import { type Pcm, type Quantity, MeasurementError, assertPcm, q } from "./types";
import { DEFAULT_THRESHOLDS, type MeasureThresholds } from "./thresholds";

export interface ClippingResult {
  /** Runs of >= minRunSamples consecutive samples pinned at the file's own per-polarity ceiling. */
  runCount: Quantity<"runs">;
  clippedSamples: Quantity<"samples">;
  longestRun: Quantity<"samples">;
  /** Per-polarity ceilings found (max positive / most negative), fraction of full scale. */
  ceilingPositive: Quantity<"FS">;
  ceilingNegative: Quantity<"FS">;
  /** Distinct excursions of the 4x oversampled signal above the trueOverDbtp level. */
  trueOverCount: Quantity<"overs">;
  trueOverThreshold: Quantity<"dBTP">;
}

/**
 * Flat-top detection relative to the file's own peak, so clipping that was
 * normalised down afterwards is still found. Needs the signal to actually
 * pin at the ceiling for >= minRunSamples samples.
 */
export function measureClipping(
  pcm: Pcm,
  th: MeasureThresholds["clipping"] = DEFAULT_THRESHOLDS.clipping,
): ClippingResult {
  assertPcm(pcm);
  let runCount = 0;
  let clipped = 0;
  let longest = 0;
  let posCeil = 0;
  let negCeil = 0;
  let overs = 0;
  const overLin = Math.pow(10, th.trueOverDbtp / 20);

  for (const ch of pcm.channels) {
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]!;
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    if (hi === 0 && lo === 0) throw new MeasurementError("SILENT_INPUT", "All samples are zero; clipping undefined.");
    posCeil = Math.max(posCeil, hi);
    negCeil = Math.min(negCeil, lo);
    const posLevel = hi * (1 - th.ceilingToleranceRel);
    const negLevel = lo * (1 - th.ceilingToleranceRel);

    let run = 0;
    let runSign = 0;
    const closeRun = () => {
      if (run >= th.minRunSamples) {
        runCount++;
        clipped += run;
        if (run > longest) longest = run;
      }
      run = 0;
      runSign = 0;
    };
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i]!;
      const sign = hi > 0 && v >= posLevel ? 1 : lo < 0 && v <= negLevel ? -1 : 0;
      if (sign !== 0 && (runSign === 0 || sign === runSign)) {
        run++;
        runSign = sign;
      } else {
        closeRun();
        if (sign !== 0) {
          run = 1;
          runSign = sign;
        }
      }
    }
    closeRun();

    let inOver = false;
    scanOversampled(ch, (v) => {
      if (v >= overLin) {
        if (!inOver) overs++;
        inOver = true;
      } else {
        inOver = false;
      }
    });
  }
  return {
    runCount: q(runCount, "runs"),
    clippedSamples: q(clipped, "samples"),
    longestRun: q(longest, "samples"),
    ceilingPositive: q(posCeil, "FS"),
    ceilingNegative: q(negCeil, "FS"),
    trueOverCount: q(overs, "overs"),
    trueOverThreshold: q(th.trueOverDbtp, "dBTP"),
  };
}
