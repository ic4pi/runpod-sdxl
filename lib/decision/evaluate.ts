import { DEFAULT_CONTEXT } from "./default";
import type { DecisionContext, MetricReading, ReferenceProfile, Rule, Severity, UserMetrics } from "./types";

/**
 * Why there is no advice without a reference. Produced here, in code, and carried in the result,
 * so no UI can forget it or reword it into something that implies advice.
 */
export const NO_REFERENCE_REASON =
  "No reference profile is selected, so no advice is given. Coaching only comes from comparing your track against a reference; without one there is nothing to compare to, and any advice would be a guess. Your own measurements are shown below. Pick a reference profile to see how your track differs.";

export interface Measurement {
  metricId: string;
  label: string;
  reading: MetricReading;
}

/** Without a reference: measurements and a reason. There is deliberately NO `coaching` and NO `deltas` field on this type. */
export interface NoReferenceResult {
  readonly kind: "no-reference";
  readonly reason: string;
  readonly measurements: readonly Measurement[];
}

/** A difference from the reference median. The reference's own absolute numbers are never exposed. */
export type DeltaRow =
  | { metricId: string; label: string; status: "ok"; delta: number; deltaUnit: string }
  | { metricId: string; label: string; status: "unavailable"; reason: string };

export interface CoachingLine {
  ruleId: string;
  metricId: string;
  severity: Severity;
  title: string;
  /** Copy with the measured delta filled in. */
  message: string;
  suggestedMove: string;
  /** Signed difference from the reference median. */
  delta: number;
  /** How far past the rule's percentile threshold the user is (always > 0). */
  beyondThreshold: number;
  deltaUnit: string;
  thresholdPct: number;
}

export interface EvaluatedResult {
  readonly kind: "evaluated";
  readonly profile: { id: string; label: string; placeholder: boolean; basis: string };
  readonly measurements: readonly Measurement[];
  readonly deltas: readonly DeltaRow[];
  readonly coaching: readonly CoachingLine[];
  /** Rules that could not be checked (and why). Never silently dropped. */
  readonly notEvaluated: readonly { ruleId: string; reason: string }[];
}

export type EvaluationResult = NoReferenceResult | EvaluatedResult;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

/** Value of the profile's distribution for `metricId` at percentile `pct`, linear between knots. */
export function profileValueAtPct(profile: ReferenceProfile, metricId: string, pct: number): number {
  const m = profile.metrics[metricId];
  if (!m) throw new Error(`Profile '${profile.id}' has no metric '${metricId}'.`);
  const k = profile.percentile_knots;
  if (pct < k[0]! || pct > k[k.length - 1]!) {
    throw new Error(`Percentile ${pct} is outside profile '${profile.id}' knots ${k[0]}-${k[k.length - 1]}.`);
  }
  for (let i = 1; i < k.length; i++) {
    if (pct <= k[i]!) {
      const t = (pct - k[i - 1]!) / (k[i]! - k[i - 1]!);
      return m.values[i - 1]! + t * (m.values[i]! - m.values[i - 1]!);
    }
  }
  return m.values[m.values.length - 1]!;
}

export function formatDelta(value: number, unit: string): string {
  const mag = Math.abs(value);
  const digits = unit === "ratio" ? (mag === 0 ? "0" : mag < 0.01 ? mag.toPrecision(2) : mag.toFixed(3)) : mag.toFixed(1);
  return `${value < 0 ? "-" : "+"}${digits}`;
}

function measurementsOf(metrics: UserMetrics, ctx: DecisionContext): Measurement[] {
  return ctx.metrics.map((m) => ({
    metricId: m.id,
    label: m.label,
    reading: metrics[m.id] ?? { status: "unavailable", reason: "Not measured." },
  }));
}

/**
 * Pure. With `profile === null` it returns a NoReferenceResult, a type that has no coaching field,
 * so advice without a reference is unrepresentable. With a profile it returns deltas vs the
 * reference median and one coaching line per rule whose percentile threshold the user is beyond.
 */
export function evaluate(profile: ReferenceProfile | null, metrics: UserMetrics, ctx: DecisionContext = DEFAULT_CONTEXT): EvaluationResult {
  const measurements = measurementsOf(metrics, ctx);
  if (profile === null) {
    return { kind: "no-reference", reason: NO_REFERENCE_REASON, measurements };
  }

  const deltas: DeltaRow[] = ctx.metrics.map((def) => {
    const r = metrics[def.id];
    if (!r || r.status !== "ok") {
      return { metricId: def.id, label: def.label, status: "unavailable", reason: r?.status === "unavailable" ? r.reason : "Not measured." };
    }
    return { metricId: def.id, label: def.label, status: "ok", delta: r.value - profileValueAtPct(profile, def.id, 50), deltaUnit: def.delta_unit };
  });

  const coaching: CoachingLine[] = [];
  const notEvaluated: { ruleId: string; reason: string }[] = [];
  const defs = new Map(ctx.metrics.map((m) => [m.id, m]));
  ctx.rules.forEach((rule: Rule) => {
    const def = defs.get(rule.metric);
    if (!def) throw new Error(`Rule '${rule.id}' references unknown metric '${rule.metric}'.`);
    const reading = metrics[rule.metric];
    if (!reading || reading.status !== "ok") {
      notEvaluated.push({ ruleId: rule.id, reason: reading?.status === "unavailable" ? reading.reason : "Metric was not measured." });
      return;
    }
    const threshold = profileValueAtPct(profile, rule.metric, rule.threshold_pct);
    const beyond = rule.direction === "above" ? reading.value - threshold : threshold - reading.value;
    if (!(beyond > 0)) return;
    const delta = reading.value - profileValueAtPct(profile, rule.metric, 50);
    const copy = ctx.coaching[rule.coaching_id];
    if (!copy) throw new Error(`Rule '${rule.id}' references unknown coaching_id '${rule.coaching_id}'.`);
    coaching.push({
      ruleId: rule.id,
      metricId: rule.metric,
      severity: rule.severity,
      title: copy.title,
      message: copy.explanation
        .replaceAll("{delta}", formatDelta(delta, def.delta_unit))
        .replaceAll("{unit}", def.delta_unit)
        .replaceAll("{profile}", profile.label),
      suggestedMove: rule.suggested_move,
      delta,
      beyondThreshold: beyond,
      deltaUnit: def.delta_unit,
      thresholdPct: rule.threshold_pct,
    });
  });
  coaching.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    kind: "evaluated",
    profile: { id: profile.id, label: profile.label, placeholder: profile._placeholder, basis: profile._basis },
    measurements,
    deltas,
    coaching,
    notEvaluated,
  };
}
