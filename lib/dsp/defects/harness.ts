import { DETECTOR_IDS, runDetectors, type DetectorId, type DetectorVerdict } from "../measure/detectors";
import type { MeasureReport } from "../measure";
import { DEFAULT_THRESHOLDS, type MeasureThresholds } from "../measure/thresholds";
import { MeasurementError, type Pcm } from "../measure/types";
import { DEFECTS, SEVERITIES, type DefectId, type Severity } from "./injectors";
import { generateSyntheticVocal, NOISE_PRINT_SEC } from "./syntheticVocal";
import { quietestWindow, slicePcm } from "./util";

/** DEV-ONLY. Builds the synthetic set, runs all detectors on each case, computes the confusion table. */
export interface HarnessCase {
  name: string;
  base: string;
  defect: DefectId | null;
  severity: Severity | null;
  /** The detector expected to fire; null for clean controls. */
  expected: DetectorId | null;
  pcm: Pcm;
  noisePrint: Pcm;
}

export interface CaseOutcome {
  name: string;
  base: string;
  defect: DefectId | null;
  severity: Severity | null;
  expected: DetectorId | null;
  verdicts: Record<DetectorId, DetectorVerdict>;
  report: MeasureReport;
}

export interface DetectorRow {
  detector: DetectorId;
  defect: DefectId;
  /** Fired on every injected variant of its own defect. */
  fires_on_defect: boolean;
  firedOnDefect: string; // "x/y"
  /** Fired on any clean control. */
  false_positive_on_control: boolean;
  firedOnControl: string;
  /** Other defects' injections this detector fired on (cross-talk). */
  crossFires: string[];
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** null when undefined (no positive predictions / no positive cases). Never a silent 0. */
  precision: number | null;
  recall: number | null;
  recallBySeverity: Record<Severity, string>;
}

export interface HarnessResult {
  outcomes: CaseOutcome[];
  rows: DetectorRow[];
  caseCount: number;
  thresholds: MeasureThresholds;
}

export interface BaseVocal {
  name: string;
  pcm: Pcm;
  noisePrint: Pcm;
}

export const SYNTHETIC_BASES = [
  { name: "synthA", seed: 1, f0Base: 130 },
  { name: "synthB", seed: 2, f0Base: 165 },
  { name: "synthC", seed: 3, f0Base: 200 },
  { name: "synthD_lowF0", seed: 4, f0Base: 95 },
] as const;

export function syntheticBases(): { name: string; seed: number; pcm: Pcm }[] {
  return SYNTHETIC_BASES.map((b) => ({ name: b.name, seed: b.seed, pcm: generateSyntheticVocal({ seed: b.seed, f0Base: b.f0Base }) }));
}

/**
 * Noise print for a (possibly injected) file. Synthetic files: the first 2.5 s (room tone only, so
 * hum/DC injected into the file are also present in the print, as they would be in a real recording).
 * Uploaded files: the quietest 2.5 s window.
 */
export function noisePrintFor(pcm: Pcm, synthetic: boolean): Pcm {
  return synthetic ? slicePcm(pcm, 0, NOISE_PRINT_SEC) : quietestWindow(pcm, NOISE_PRINT_SEC);
}

export function buildCases(bases: { name: string; seed: number; pcm: Pcm }[], synthetic: boolean): HarnessCase[] {
  const cases: HarnessCase[] = [];
  for (const b of bases) {
    cases.push({
      name: `${b.name} / clean`,
      base: b.name,
      defect: null,
      severity: null,
      expected: null,
      pcm: b.pcm,
      noisePrint: noisePrintFor(b.pcm, synthetic),
    });
    for (const d of DEFECTS) {
      for (const s of SEVERITIES) {
        const pcm = d.inject(b.pcm, s, b.seed);
        cases.push({
          name: `${b.name} / ${d.id}:${s}`,
          base: b.name,
          defect: d.id,
          severity: s,
          expected: d.target,
          pcm,
          noisePrint: noisePrintFor(pcm, synthetic),
        });
      }
    }
  }
  return cases;
}

export type MeasureFn = (pcm: Pcm, noisePrint: Pcm) => Promise<MeasureReport>;

export async function runHarness(
  cases: HarnessCase[],
  measure: MeasureFn,
  thresholds: MeasureThresholds = DEFAULT_THRESHOLDS,
  onProgress?: (done: number, total: number) => void,
): Promise<HarnessResult> {
  const outcomes: CaseOutcome[] = [];
  for (const c of cases) {
    const report = await measure(c.pcm, c.noisePrint);
    // The control must measure cleanly end to end; a failed measurement is a harness failure, not a "no fire".
    for (const [k, v] of Object.entries(report)) {
      if (typeof v === "object" && v && "ok" in v && !v.ok && k !== "correlation") {
        throw new MeasurementError("INTERNAL", `${c.name}: measurement '${k}' failed: ${v.error.code}: ${v.error.message}`);
      }
    }
    outcomes.push({
      name: c.name,
      base: c.base,
      defect: c.defect,
      severity: c.severity,
      expected: c.expected,
      verdicts: runDetectors(report, thresholds),
      report,
    });
    onProgress?.(outcomes.length, cases.length);
  }
  return { outcomes, rows: computeRows(outcomes), caseCount: cases.length, thresholds };
}

export function computeRows(outcomes: CaseOutcome[]): DetectorRow[] {
  return DETECTOR_IDS.map((det) => {
    const spec = DEFECTS.find((d) => d.target === det)!;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    const own = outcomes.filter((o) => o.expected === det);
    const controls = outcomes.filter((o) => o.expected === null);
    const cross = new Set<string>();
    for (const o of outcomes) {
      const fired = o.verdicts[det].fired;
      const positive = o.expected === det;
      if (positive && fired) tp++;
      else if (positive) fn++;
      else if (fired) {
        fp++;
        if (o.defect) cross.add(o.defect);
      } else tn++;
    }
    const ownFired = own.filter((o) => o.verdicts[det].fired).length;
    const ctlFired = controls.filter((o) => o.verdicts[det].fired).length;
    const recallBySeverity = Object.fromEntries(
      SEVERITIES.map((s) => {
        const set = own.filter((o) => o.severity === s);
        return [s, `${set.filter((o) => o.verdicts[det].fired).length}/${set.length}`];
      }),
    ) as Record<Severity, string>;
    return {
      detector: det,
      defect: spec.id,
      fires_on_defect: own.length > 0 && ownFired === own.length,
      firedOnDefect: `${ownFired}/${own.length}`,
      false_positive_on_control: ctlFired > 0,
      firedOnControl: `${ctlFired}/${controls.length}`,
      crossFires: [...cross],
      tp,
      fp,
      fn,
      tn,
      precision: tp + fp > 0 ? tp / (tp + fp) : null,
      recall: tp + fn > 0 ? tp / (tp + fn) : null,
      recallBySeverity,
    };
  });
}

export function formatRowsText(rows: DetectorRow[]): string {
  const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
  const head = ["detector", "fires_on_defect", "false_pos_on_control", "precision", "recall", "TP", "FP", "FN", "TN", "mild", "moderate", "severe", "cross-fires"];
  const lines = rows.map((r) => [
    r.detector,
    `${r.fires_on_defect} (${r.firedOnDefect})`,
    `${r.false_positive_on_control} (${r.firedOnControl})`,
    f(r.precision),
    f(r.recall),
    String(r.tp),
    String(r.fp),
    String(r.fn),
    String(r.tn),
    r.recallBySeverity.mild,
    r.recallBySeverity.moderate,
    r.recallBySeverity.severe,
    r.crossFires.join(",") || "-",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ");
  return [fmt(head), widths.map((w) => "-".repeat(w)).join("-+-"), ...lines.map(fmt)].join("\n");
}
