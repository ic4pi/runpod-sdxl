/**
 * Phase 3 decision-table tests. INPUTS ARE SYNTHETIC METRIC VALUES built from the (invented) placeholder
 * profiles. No audio of any kind is used in this file.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import coachingJson from "../lib/decision/coaching.json";
import { DEFAULT_CONTEXT } from "../lib/decision/default";
import { evaluate, NO_REFERENCE_REASON, profileValueAtPct, type CoachingLine, type EvaluatedResult, type NoReferenceResult } from "../lib/decision/evaluate";
import { validateContext, validateProfile } from "../lib/decision/load";
import tableJson from "../lib/decision/table.json";
import type { DecisionContext, MetricReading, ReferenceProfile, Rule, UserMetrics } from "../lib/decision/types";
import { MEASURE_FUNCTIONS } from "../lib/reference/measureFns";
import { PROFILES } from "../lib/reference/profiles";

const CTX = DEFAULT_CONTEXT;
const unitOf = (id: string) => CTX.metrics.find((m) => m.id === id)!.unit;

/** Every metric sitting at the profile's median: nothing should fire. */
function atMedian(p: ReferenceProfile): Record<string, MetricReading> {
  return Object.fromEntries(CTX.metrics.map((m) => [m.id, { status: "ok", value: profileValueAtPct(p, m.id, 50), unit: m.unit } as MetricReading]));
}
const withMetric = (base: Record<string, MetricReading>, id: string, value: number): UserMetrics => ({ ...base, [id]: { status: "ok", value, unit: unitOf(id) } });

/** A user value just past (or just inside) a rule's percentile threshold. */
function pastThreshold(p: ReferenceProfile, r: Rule, side: "beyond" | "inside"): number {
  const thr = profileValueAtPct(p, r.metric, r.threshold_pct);
  const eps = 1e-3 * Math.max(1, Math.abs(thr));
  const sign = (r.direction === "above" ? 1 : -1) * (side === "beyond" ? 1 : -1);
  return thr + sign * eps;
}

const asEvaluated = (r: ReturnType<typeof evaluate>): EvaluatedResult => {
  expect(r.kind).toBe("evaluated");
  return r as EvaluatedResult;
};

describe("shipped data: table, registry, profiles", () => {
  it("table.json has the schema fields on every rule and >= 8 rules covering the required cases", () => {
    const keys = ["calibration", "coaching_id", "direction", "id", "metric", "severity", "suggested_move", "threshold_pct"];
    for (const r of tableJson.rules) expect(Object.keys(r).sort()).toEqual(keys);
    expect(tableJson.rules.length).toBeGreaterThanOrEqual(8);
    const has = (metric: string, direction: string) => tableJson.rules.some((r) => r.metric === metric && r.direction === direction);
    expect(has("presence_3k5_rel_db", "above")).toBe(true); // presence high
    expect(has("presence_3k5_rel_db", "below")).toBe(true); // presence low
    expect(has("boxiness_250hz_rel_db", "above")).toBe(true);
    expect(has("sibilance_5k9k_rel_db", "above")).toBe(true);
    expect(has("plosive_events_per_min", "above")).toBe(true);
    expect(has("noise_floor_dbfs", "above")).toBe(true);
    expect(has("clipped_sample_ratio", "above")).toBe(true);
    expect(has("integrated_lufs", "above")).toBe(true); // over target
    expect(has("integrated_lufs", "below")).toBe(true); // under target
    expect(has("lra_lu", "above")).toBe(true); // LRA too wide
  });

  it("every metric names a real Phase 1 function (exported from lib/dsp/measure) and carries units + a definition", () => {
    for (const m of CTX.metrics) {
      const entry = (MEASURE_FUNCTIONS as Record<string, { fn: Function; reportKey: string }>)[m.measure_fn];
      expect(entry, m.id).toBeDefined();
      expect(typeof entry!.fn).toBe("function");
      expect(entry!.fn.name).toBe(m.measure_fn);
      expect(m.unit.length).toBeGreaterThan(0);
      expect(m.delta_unit.length).toBeGreaterThan(0);
      expect(m.definition.length).toBeGreaterThan(60);
    }
  });

  it("every rule references an existing metric and coaching copy, and every threshold carries an exact-corpus CALIBRATE note", () => {
    for (const r of tableJson.rules) {
      expect(CTX.metrics.some((m) => m.id === r.metric), r.id).toBe(true);
      expect(Object.keys(coachingJson.coaching), r.id).toContain(r.coaching_id);
      expect(r.calibration, r.id).toMatch(/^TODO: CALIBRATE — corpus: .*N>=\d+/);
      expect(r.calibration, r.id).not.toMatch(/\bpopulation\b/i); // must name the corpus itself
    }
  });

  it("3-5 stock profiles, each flagged _placeholder with a _basis naming the replacing corpus and an 'invented' statement", () => {
    expect(PROFILES.length).toBeGreaterThanOrEqual(3);
    expect(PROFILES.length).toBeLessThanOrEqual(5);
    expect(PROFILES.map((p) => p.id)).toEqual(expect.arrayContaining(["trap", "boom-bap", "drill"]));
    for (const p of PROFILES) {
      expect(p._placeholder).toBe(true);
      expect(p._basis).toMatch(/N>=\d+/);
      expect(p._basis).toMatch(/stems/);
      expect(p._invented).toMatch(/invented/i);
      expect(p.label).toMatch(/placeholder/i);
    }
  });

  it("profiles hold only metric fingerprints (numbers per percentile knot), no audio", () => {
    for (const p of PROFILES) {
      for (const [, m] of Object.entries(p.metrics)) {
        expect(m.values).toHaveLength(p.percentile_knots.length);
        expect(m.values.every((v) => typeof v === "number")).toBe(true);
      }
    }
  });

  it("the loader rejects a profile without _placeholder or _basis, and one missing a metric", () => {
    const ids = CTX.metrics.map((m) => m.id);
    const base = JSON.parse(JSON.stringify(PROFILES[0])) as ReferenceProfile;
    expect(() => validateProfile({ ...base, _placeholder: false }, ids)).toThrow(/_placeholder/);
    expect(() => validateProfile({ ...base, _basis: "" }, ids)).toThrow(/_basis/);
    expect(() => validateProfile({ ...base, _basis: "trap tracks, a lot of them, measured somehow, sometime" }, ids)).toThrow(/_basis/); // no N>=
    const missing = { ...base, metrics: { ...base.metrics } } as { metrics: Record<string, unknown> } & ReferenceProfile;
    delete missing.metrics["lra_lu"];
    expect(() => validateProfile(missing, ids)).toThrow(/missing metric 'lra_lu'/);
  });
});

describe("every rule fires on synthetic metric input (and only past its threshold)", () => {
  for (const profile of PROFILES) {
    describe(`profile ${profile.id}`, () => {
      const base = atMedian(profile);

      it("nothing fires when every metric sits at the reference median", () => {
        const r = asEvaluated(evaluate(profile, base));
        expect(r.coaching).toEqual([]);
        expect(r.notEvaluated).toEqual([]);
      });

      for (const rule of tableJson.rules as Rule[]) {
        it(`${rule.id}: fires just beyond P${rule.threshold_pct} ${rule.direction}, silent just inside`, () => {
          const fired = asEvaluated(evaluate(profile, withMetric(base, rule.metric, pastThreshold(profile, rule, "beyond"))));
          const line = fired.coaching.find((c) => c.ruleId === rule.id);
          expect(line, "rule did not fire").toBeDefined();
          expect(line!.suggestedMove).toBe(rule.suggested_move);
          expect(line!.severity).toBe(rule.severity);
          expect(line!.beyondThreshold).toBeGreaterThan(0);
          expect(line!.message).not.toMatch(/[{}]/); // all template tokens filled
          const quiet = asEvaluated(evaluate(profile, withMetric(base, rule.metric, pastThreshold(profile, rule, "inside"))));
          expect(quiet.coaching.find((c) => c.ruleId === rule.id)).toBeUndefined();
        });
      }
    });
  }
});

describe("deltas and what is (not) exposed", () => {
  const profile = PROFILES[0]!;
  const base = atMedian(profile);

  it("a delta is user minus the reference median, in the metric's delta unit", () => {
    const r = asEvaluated(evaluate(profile, withMetric(base, "presence_3k5_rel_db", profileValueAtPct(profile, "presence_3k5_rel_db", 50) + 3)));
    const row = r.deltas.find((d) => d.metricId === "presence_3k5_rel_db")!;
    expect(row.status).toBe("ok");
    if (row.status === "ok") {
      expect(row.delta).toBeCloseTo(3, 9);
      expect(row.deltaUnit).toBe("dB");
    }
    const lufs = r.deltas.find((d) => d.metricId === "integrated_lufs")!;
    if (lufs.status === "ok") expect(lufs.deltaUnit).toBe("LU");
  });

  it("no profile absolute value appears anywhere in the result", () => {
    // user values deliberately offset by an irrational-ish amount so no legitimate number equals a knot
    const odd: Record<string, MetricReading> = Object.fromEntries(
      CTX.metrics.map((m) => [m.id, { status: "ok", value: profileValueAtPct(profile, m.id, 50) + 0.1234567, unit: m.unit } as MetricReading]),
    );
    const result = asEvaluated(evaluate(profile, withMetric(odd, "clipped_sample_ratio", 0.00123)));
    const numbers = new Set<number>();
    const walk = (x: unknown): void => {
      if (typeof x === "number") numbers.add(x);
      else if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(result); // every numeric value actually present in the result object
    for (const m of Object.values(profile.metrics)) {
      for (const v of m.values) if (v !== 0) expect(numbers.has(v), `profile value ${v} leaked`).toBe(false);
    }
  });

  it("an unavailable metric yields 'unavailable' and a not-evaluated rule, never a zero", () => {
    const noNoise: UserMetrics = { ...base, noise_floor_dbfs: { status: "unavailable", reason: "no valid noise print" } };
    const r = asEvaluated(evaluate(profile, noNoise));
    const row = r.deltas.find((d) => d.metricId === "noise_floor_dbfs")!;
    expect(row.status).toBe("unavailable");
    expect(r.notEvaluated.map((n) => n.ruleId)).toContain("noise_floor_high");
    expect(r.notEvaluated.find((n) => n.ruleId === "noise_floor_high")!.reason).toBe("no valid noise print");
    expect(r.coaching.find((c) => c.metricId === "noise_floor_dbfs")).toBeUndefined();
  });

  it("critical advice sorts before warnings and info; same-severity order follows the table", () => {
    const hot: UserMetrics = Object.fromEntries(
      tableJson.rules.map((r) => [r.metric, { status: "ok", value: pastThreshold(profile, r as Rule, "beyond"), unit: unitOf(r.metric) } as MetricReading]),
    );
    const lines = asEvaluated(evaluate(profile, { ...base, ...hot })).coaching;
    const rank = { critical: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < lines.length; i++) expect(rank[lines[i]!.severity]).toBeGreaterThanOrEqual(rank[lines[i - 1]!.severity]);
    expect(lines[0]!.ruleId).toBe("clipping_present");
  });

  it("is pure: same input -> same output, input untouched", () => {
    const frozen = Object.freeze({ ...withMetric(base, "lra_lu", 99) });
    expect(evaluate(profile, frozen)).toEqual(evaluate(profile, frozen));
  });
});

describe("NO REFERENCE => no coaching, enforced by the result TYPE", () => {
  const profile = PROFILES[0]!;
  // metrics that would trip EVERY rule if a reference were selected
  const screaming: UserMetrics = Object.fromEntries(
    tableJson.rules.map((r) => [r.metric, { status: "ok", value: pastThreshold(profile, r as Rule, "beyond"), unit: unitOf(r.metric) } as MetricReading]),
  );
  const fullMetrics: UserMetrics = { ...atMedian(profile), ...screaming };

  it("evaluate(null, metrics) returns kind 'no-reference' with the reason and the user's own measurements", () => {
    const r = evaluate(null, fullMetrics);
    expect(r.kind).toBe("no-reference");
    if (r.kind !== "no-reference") throw new Error("unreachable");
    expect(r.reason).toBe(NO_REFERENCE_REASON);
    expect(r.reason).toMatch(/no advice/i);
    expect(r.measurements).toHaveLength(CTX.metrics.length);
    expect(r.measurements.every((m) => m.reading.status === "ok")).toBe(true);
  });

  it("the no-reference result has no coaching, no deltas, no profile (runtime)", () => {
    const r = evaluate(null, fullMetrics);
    expect("coaching" in r).toBe(false);
    expect("deltas" in r).toBe(false);
    expect("profile" in r).toBe(false);
    expect("notEvaluated" in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual(["kind", "measurements", "reason"]);
  });

  it("...and cannot be given any (compile time: this file is typechecked by `tsc`)", () => {
    const r = evaluate(null, fullMetrics);
    if (r.kind === "no-reference") {
      // @ts-expect-error NoReferenceResult has no `coaching` property
      void r.coaching;
      // @ts-expect-error NoReferenceResult has no `deltas` property
      void r.deltas;
    }
    expectTypeOf<NoReferenceResult>().not.toHaveProperty("coaching");
    expectTypeOf<NoReferenceResult>().not.toHaveProperty("deltas");
    expectTypeOf<EvaluatedResult>().toHaveProperty("coaching");
    expectTypeOf<EvaluatedResult["coaching"]>().toEqualTypeOf<readonly CoachingLine[]>();
    expectTypeOf(evaluate).returns.toEqualTypeOf<NoReferenceResult | EvaluatedResult>();
  });

  it("even with a custom decision context containing a rule that always fires, null reference yields no coaching", () => {
    const always: Rule = { ...(tableJson.rules[0] as Rule), id: "always", threshold_pct: 10, direction: "above" };
    const ctx: DecisionContext = { ...CTX, rules: [always] };
    const r = evaluate(null, fullMetrics, ctx);
    expect(r.kind).toBe("no-reference");
    expect("coaching" in r).toBe(false);
  });

  it("selecting a reference flips it: same metrics, now coaching exists", () => {
    const r = asEvaluated(evaluate(profile, fullMetrics));
    expect(r.coaching.length).toBeGreaterThanOrEqual(8);
  });
});

describe("table is data: adding a rule touches no TypeScript", () => {
  const profile = PROFILES[0]!;
  const extra: Rule = {
    id: "crest_high_demo",
    metric: "crest_active_db",
    threshold_pct: 75,
    direction: "above",
    coaching_id: "lra_wide",
    suggested_move: "Demo rule added purely as JSON-shaped data.",
    severity: "info",
    calibration: "TODO: CALIBRATE — corpus: isolated lead-vocal stems of commercially released trap tracks, N>=200, measured with lib/dsp/measure.",
  };
  const ctx = validateContext({ ...CTX, rules: [...CTX.rules, extra] }, PROFILES);

  it("a new JSON rule is validated and fires", () => {
    const base = atMedian(profile);
    const r = asEvaluated(evaluate(profile, withMetric(base, "crest_active_db", profileValueAtPct(profile, "crest_active_db", 75) + 0.5), ctx));
    expect(r.coaching.map((c) => c.ruleId)).toContain("crest_high_demo");
  });

  it("the validator rejects malformed rules", () => {
    const bad = (patch: Partial<Rule>) => () => validateContext({ ...CTX, rules: [{ ...extra, ...patch }] }, PROFILES);
    expect(bad({ metric: "vibes" })).toThrow(/unknown metric/);
    expect(bad({ coaching_id: "nope" })).toThrow(/unknown coaching_id/);
    expect(bad({ calibration: "TODO: CALIBRATE — corpus: top tracks" })).toThrow(/calibration/);
    expect(bad({ calibration: "calibrate later" })).toThrow(/calibration/);
    expect(bad({ threshold_pct: 99 })).toThrow(/outside profile/);
    expect(bad({ direction: "sideways" as never })).toThrow(/direction/);
    expect(() => validateContext({ ...CTX, metrics: [{ ...CTX.metrics[0]!, measure_fn: "measureVibes" }] })).toThrow(/measure_fn/);
  });
});
