export type Severity = "info" | "warn" | "critical";
export type Direction = "above" | "below";

export type ExtractSpec =
  | { kind: "field"; path: string; unit_path: string }
  | { kind: "band_rel_db"; centers_hz: number[] }
  | { kind: "ratio"; numerator_path: string; numerator_unit: string; denominator: "total_samples" }
  | { kind: "per_minute"; path: string; unit_path: string };

export interface MetricDef {
  id: string;
  label: string;
  /** Exact exported function in lib/dsp/measure/* this metric reads. */
  measure_fn: string;
  unit: string;
  delta_unit: string;
  definition: string;
  extract: ExtractSpec;
}

export interface Rule {
  id: string;
  metric: string;
  /** Percentile (0-100) of the selected profile's corpus distribution for `metric`. */
  threshold_pct: number;
  direction: Direction;
  coaching_id: string;
  suggested_move: string;
  severity: Severity;
  /** Must start with "TODO: CALIBRATE — corpus:" and name the exact population. */
  calibration: string;
}

export interface CoachingCopy {
  title: string;
  explanation: string;
}

export interface DecisionContext {
  metrics: readonly MetricDef[];
  rules: readonly Rule[];
  coaching: Readonly<Record<string, CoachingCopy>>;
}

/** What the measurement module produced for one metric. Unavailable is explicit, never a zero. */
export type MetricReading =
  | { status: "ok"; value: number; unit: string }
  | { status: "unavailable"; reason: string };

export type UserMetrics = Readonly<Record<string, MetricReading>>;

export interface ReferenceProfile {
  _placeholder: boolean;
  _basis: string;
  _invented: string;
  id: string;
  label: string;
  version: number;
  percentile_knots: readonly number[];
  metrics: Readonly<Record<string, { unit: string; values: readonly number[] }>>;
}
