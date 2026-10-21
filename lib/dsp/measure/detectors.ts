import type { MeasureReport } from "./index";
import { DEFAULT_THRESHOLDS, type MeasureThresholds } from "./thresholds";
import { MeasurementError, type Quantity, q } from "./types";

export type DetectorId = "clipping" | "hum" | "plosive" | "dc_offset";
export const DETECTOR_IDS: readonly DetectorId[] = ["clipping", "hum", "plosive", "dc_offset"];

export interface DetectorVerdict {
  id: DetectorId;
  fired: boolean;
  /** The measured number the decision was made on. */
  metric: Quantity<string>;
  /** The placeholder threshold it was compared to. */
  threshold: Quantity<string>;
}

function need<T>(m: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }, name: string): T {
  if (!m.ok) throw new MeasurementError("INTERNAL", `Detector input '${name}' failed: ${m.error.code}: ${m.error.message}`);
  return m.value;
}

/** Pure verdicts over a measurement report. Throws if a required measurement failed. */
export function runDetectors(
  report: MeasureReport,
  th: MeasureThresholds = DEFAULT_THRESHOLDS,
): Record<DetectorId, DetectorVerdict> {
  const clip = need(report.clipping, "clipping");
  const hum = need(report.hum, "hum");
  const plo = need(report.plosive, "plosive");
  const dc = need(report.dcOffset, "dcOffset");
  return {
    clipping: {
      id: "clipping",
      fired: clip.runCount.value >= th.clipping.minRunsToFire,
      metric: clip.runCount,
      threshold: q(th.clipping.minRunsToFire, "runs"),
    },
    hum: {
      id: "hum",
      fired: hum.best.harmonicsPresent >= th.hum.minHarmonicsToFire,
      metric: q(hum.best.harmonicsPresent, "harmonics"),
      threshold: q(th.hum.minHarmonicsToFire, "harmonics"),
    },
    plosive: {
      id: "plosive",
      fired: plo.eventCount.value >= th.plosive.minEventsToFire,
      metric: plo.eventCount,
      threshold: q(th.plosive.minEventsToFire, "events"),
    },
    dc_offset: {
      id: "dc_offset",
      fired: dc.maxAbs.value >= th.dcOffset.fireAbsFs,
      metric: dc.maxAbs,
      threshold: q(th.dcOffset.fireAbsFs, "FS"),
    },
  };
}
