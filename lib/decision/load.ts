import { MEASURE_FUNCTIONS } from "../reference/measureFns";
import type { CoachingCopy, DecisionContext, MetricDef, ReferenceProfile, Rule } from "./types";

const SEVERITIES = ["info", "warn", "critical"];
const DIRECTIONS = ["above", "below"];
const CAL_PREFIX = "TODO: CALIBRATE — corpus:";
const EXTRACT_KINDS = ["field", "band_rel_db", "ratio", "per_minute"];

const fail = (msg: string): never => {
  throw new Error(`Invalid decision data: ${msg}`);
};

export function validateProfile(p: ReferenceProfile, metricIds: readonly string[]): ReferenceProfile {
  if (typeof p.id !== "string" || !p.id) fail("profile without id");
  const where = `profile '${p.id}'`;
  if (p._placeholder !== true) fail(`${where}: _placeholder must be true until measured data replaces it`);
  if (typeof p._basis !== "string" || p._basis.length < 40 || !/N>=\d+/.test(p._basis)) fail(`${where}: _basis must name the replacing corpus incl. N>=...`);
  if (typeof p._invented !== "string" || !/invented/i.test(p._invented)) fail(`${where}: _invented statement missing`);
  const knots = p.percentile_knots;
  if (!Array.isArray(knots) || knots.length < 2) fail(`${where}: percentile_knots`);
  for (let i = 0; i < knots.length; i++) {
    if (!(knots[i]! >= 0 && knots[i]! <= 100) || (i > 0 && knots[i]! <= knots[i - 1]!)) fail(`${where}: percentile_knots must be increasing within 0-100`);
  }
  for (const id of metricIds) {
    const m = p.metrics[id];
    if (!m) fail(`${where}: missing metric '${id}'`);
    const vals = m!.values;
    if (vals.length !== knots.length) fail(`${where}: metric '${id}' needs ${knots.length} values`);
    for (let i = 0; i < vals.length; i++) {
      if (!Number.isFinite(vals[i]!) || (i > 0 && vals[i]! < vals[i - 1]!)) fail(`${where}: metric '${id}' values must be finite and non-decreasing`);
    }
  }
  return p;
}

export function validateContext(ctx: DecisionContext, profiles: readonly ReferenceProfile[] = []): DecisionContext {
  const ids = new Set<string>();
  for (const m of ctx.metrics as readonly MetricDef[]) {
    if (ids.has(m.id)) fail(`duplicate metric ${m.id}`);
    ids.add(m.id);
    if (!(m.measure_fn in MEASURE_FUNCTIONS)) fail(`metric '${m.id}': measure_fn '${m.measure_fn}' is not a function in lib/dsp/measure`);
    if (!m.unit || !m.delta_unit || m.definition.length < 40) fail(`metric '${m.id}': unit/delta_unit/definition required`);
    if (!EXTRACT_KINDS.includes(m.extract.kind)) fail(`metric '${m.id}': unknown extract kind`);
  }
  const ruleIds = new Set<string>();
  for (const r of ctx.rules as readonly Rule[]) {
    const w = `rule '${r.id}'`;
    if (ruleIds.has(r.id)) fail(`duplicate rule ${r.id}`);
    ruleIds.add(r.id);
    if (!ids.has(r.metric)) fail(`${w}: unknown metric '${r.metric}'`);
    if (!DIRECTIONS.includes(r.direction)) fail(`${w}: direction`);
    if (!SEVERITIES.includes(r.severity)) fail(`${w}: severity`);
    if (!(ctx.coaching as Record<string, CoachingCopy>)[r.coaching_id]) fail(`${w}: unknown coaching_id '${r.coaching_id}'`);
    if (typeof r.suggested_move !== "string" || r.suggested_move.length < 10) fail(`${w}: suggested_move`);
    if (typeof r.threshold_pct !== "number" || !(r.threshold_pct > 0 && r.threshold_pct < 100)) fail(`${w}: threshold_pct must be a percentile in (0,100)`);
    if (!r.calibration.startsWith(CAL_PREFIX) || !/N>=\d+/.test(r.calibration) || r.calibration.length < 80) {
      fail(`${w}: calibration must start with '${CAL_PREFIX}' and name the exact population including N>=...`);
    }
    for (const p of profiles) {
      const k = p.percentile_knots;
      if (r.threshold_pct < k[0]! || r.threshold_pct > k[k.length - 1]!) fail(`${w}: threshold_pct ${r.threshold_pct} outside profile '${p.id}' knots`);
    }
  }
  return ctx;
}
