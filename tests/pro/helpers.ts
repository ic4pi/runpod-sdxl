import { DEFAULT_CONTEXT } from "../../lib/decision/default";
import { evaluate, profileValueAtPct } from "../../lib/decision/evaluate";
import type { MetricReading, ReferenceProfile, UserMetrics } from "../../lib/decision/types";
import { buildPhrasingPayload } from "../../lib/pro/findings";
import type { PhrasingPayload } from "../../lib/pro/schema";
import { PROFILES } from "../../lib/reference/profiles";

export const trap = PROFILES.find((p) => p.id === "trap")!;

export function metricsAtMedian(p: ReferenceProfile = trap): Record<string, MetricReading> {
  return Object.fromEntries(DEFAULT_CONTEXT.metrics.map((m) => [m.id, { status: "ok", value: profileValueAtPct(p, m.id, 50), unit: m.unit } as MetricReading]));
}

/** Synthetic metrics that trip exactly the named rules' metrics (value = P(threshold) +/- a margin). */
export function metricsTripping(overrides: Record<string, number>, p: ReferenceProfile = trap): UserMetrics {
  const base = metricsAtMedian(p);
  for (const [id, v] of Object.entries(overrides)) base[id] = { status: "ok", value: v, unit: DEFAULT_CONTEXT.metrics.find((m) => m.id === id)!.unit };
  return base;
}

export function payloadFrom(metrics: UserMetrics, p: ReferenceProfile = trap): PhrasingPayload {
  const b = buildPhrasingPayload(evaluate(p, metrics));
  if (!b.ok) throw new Error(`no payload: ${b.reason}`);
  return b.payload;
}

/** sibilance +4 dB over median (beyond P90), pops 9/min, clipping 1%: three findings. */
export const THREE_FINDINGS = () =>
  payloadFrom(metricsTripping({ sibilance_5k9k_rel_db: profileValueAtPct(trap, "sibilance_5k9k_rel_db", 90) + 1.37, plosive_events_per_min: 9.2, clipped_sample_ratio: 0.0123 }));

/** A number that appears nowhere in the payloads used by these tests. */
export const ABSENT = 777;
