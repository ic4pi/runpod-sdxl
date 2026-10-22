import type { MeasureReport } from "../dsp/measure";
import type { ThirdOctaveResult } from "../dsp/measure/thirdOctave";
import type { MetricDef, MetricReading, UserMetrics } from "../decision/types";
import { MEASURE_FUNCTIONS, type MeasureFnName } from "./measureFns";

export interface ExtractContext {
  /** Needed for ratio / per-minute metrics. */
  durationSec: number;
  sampleRate: number;
  channels: number;
}

const BAND_MATCH_TOLERANCE = 0.02; // nominal centre vs exact base-10 centre (251 vs 250 is 0.5%)

function dig(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function num(obj: unknown, path: string, what: string): number {
  const v = dig(obj, path);
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what}: result has no finite number at '${path}'.`);
  return v;
}

function bandRelDb(res: ThirdOctaveResult, centers: readonly number[]): number {
  let power = 0;
  for (const c of centers) {
    const band = res.bands.find((b) => Math.abs(b.centerHz - c) / c <= BAND_MATCH_TOLERANCE);
    if (!band) throw new Error(`No ${c} Hz third-octave band in the measurement (sample rate too low?).`);
    power += Math.pow(10, band.level.value / 10);
  }
  return 10 * Math.log10(power) - res.total.value;
}

function readMetric(def: MetricDef, report: MeasureReport, ctx: ExtractContext): number {
  const fn = MEASURE_FUNCTIONS[def.measure_fn as MeasureFnName];
  if (!fn) throw new Error(`Metric ${def.id}: unknown measure_fn '${def.measure_fn}'.`);
  const m = report[fn.reportKey];
  if (!m.ok) throw new Error(`${def.measure_fn} failed: ${m.error.code}: ${m.error.message}`);
  const res = m.value;
  const e = def.extract;
  switch (e.kind) {
    case "field": {
      const unit = dig(res, e.unit_path);
      if (unit !== def.unit) throw new Error(`Metric ${def.id}: ${def.measure_fn} reports unit '${String(unit)}', registry says '${def.unit}'.`);
      return num(res, e.path, def.id);
    }
    case "band_rel_db":
      return bandRelDb(res as ThirdOctaveResult, e.centers_hz);
    case "ratio": {
      const unit = dig(res, e.numerator_path.replace(/\.value$/, ".unit"));
      if (unit !== e.numerator_unit) throw new Error(`Metric ${def.id}: numerator unit '${String(unit)}' is not '${e.numerator_unit}'.`);
      const total = ctx.durationSec * ctx.sampleRate * ctx.channels;
      if (!(total > 0)) throw new Error(`Metric ${def.id}: cannot form a ratio over zero samples.`);
      return num(res, e.numerator_path, def.id) / total;
    }
    case "per_minute": {
      if (!(ctx.durationSec > 0)) throw new Error(`Metric ${def.id}: zero duration.`);
      const unit = dig(res, e.unit_path);
      if (typeof unit !== "string") throw new Error(`Metric ${def.id}: result has no unit at '${e.unit_path}'.`);
      return num(res, e.path, def.id) / (ctx.durationSec / 60);
    }
  }
}

/**
 * Turns a Phase 1 MeasureReport into the user's metric readings, as declared in lib/decision/metrics.json.
 * A measurement that failed (or is missing, e.g. noise without a print) yields an explicit
 * `unavailable` reading with the reason, never a 0.
 */
export function extractMetrics(report: MeasureReport, ctx: ExtractContext, defs: readonly MetricDef[]): UserMetrics {
  const out: Record<string, MetricReading> = {};
  for (const def of defs) {
    try {
      out[def.id] = { status: "ok", value: readMetric(def, report, ctx), unit: def.unit };
    } catch (e) {
      out[def.id] = { status: "unavailable", reason: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}
