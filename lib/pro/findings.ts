import { DEFAULT_CONTEXT } from "../decision/default";
import { formatDelta, type EvaluatedResult, type EvaluationResult } from "../decision/evaluate";
import { COACHING_IDS, PhrasingPayloadSchema, type CoachingId, type Finding, type PhrasedItem, type PhrasingPayload } from "./schema";
import { PRO_CONFIG } from "./config";

/**
 * Builds the LLM's only input from Tier 1's deterministic output. Pure.
 * No reference => there is no coaching => there is nothing to phrase => `null` (and the Free path never gets here).
 * Every number is already rounded to the display precision Tier 1 shows, so the exact token exists in the input text too.
 */
export type PayloadBuild =
  | { ok: true; payload: PhrasingPayload }
  | { ok: false; reason: "no-reference" | "nothing-to-phrase" | "invalid-payload" };

const isCoachingId = (x: string): x is CoachingId => (COACHING_IDS as readonly string[]).includes(x);

export function buildPhrasingPayload(result: EvaluationResult): PayloadBuild {
  if (result.kind === "no-reference") return { ok: false, reason: "no-reference" };
  return fromEvaluated(result);
}

function fromEvaluated(result: EvaluatedResult): PayloadBuild {
  const labels = new Map(DEFAULT_CONTEXT.metrics.map((m) => [m.id, m.label]));
  const rules = new Map(DEFAULT_CONTEXT.rules.map((r) => [r.id, r]));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const c of result.coaching) {
    const rule = rules.get(c.ruleId);
    if (!rule || !isCoachingId(rule.coaching_id) || seen.has(rule.coaching_id)) continue; // one finding per coaching_id
    const copy = DEFAULT_CONTEXT.coaching[rule.coaching_id]!;
    seen.add(rule.coaching_id);
    findings.push({
      rule_id: c.ruleId,
      coaching_id: rule.coaching_id,
      metric_id: c.metricId,
      metric_label: labels.get(c.metricId) ?? c.metricId,
      severity: c.severity,
      direction: rule.direction,
      delta: Number(formatDelta(c.delta, c.deltaUnit)),
      delta_unit: c.deltaUnit as Finding["delta_unit"],
      tier1: { title: c.title || copy.title, message: c.message, suggested_move: c.suggestedMove },
    });
  }
  if (findings.length === 0) return { ok: false, reason: "nothing-to-phrase" };
  const limited = findings.slice(0, PRO_CONFIG.limits.maxFindings);
  const metric_deltas: PhrasingPayload["metric_deltas"] = {};
  for (const f of limited) metric_deltas[f.metric_id] = { label: f.metric_label, delta: f.delta, unit: f.delta_unit };
  // Never throw into the UI: a payload that fails its own schema simply means "nothing to send" (Tier 1 text stays).
  const parsed = PhrasingPayloadSchema.safeParse({
      schema_version: 1,
      reference_genre: result.profile.id,
      reference_genre_label: result.profile.label,
      reference_is_placeholder: result.profile.placeholder,
      coaching_ids: limited.map((f) => f.coaching_id),
      detected_findings: limited,
      metric_deltas,
  });
  return parsed.success ? { ok: true, payload: parsed.data } : { ok: false, reason: "invalid-payload" };
}

/** Tier 1's own text in the output shape. This is the fallback: it can always be produced and needs no network. */
export function tier1FallbackItems(payload: PhrasingPayload): PhrasedItem[] {
  const L = PRO_CONFIG.limits;
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
  return payload.detected_findings.map((f) => ({
    coaching_id: f.coaching_id,
    headline: cut(f.tier1.title, L.headlineMaxChars),
    explanation: cut(f.tier1.message, L.explanationMaxChars),
    suggested_move: cut(f.tier1.suggested_move, L.suggestedMoveMaxChars),
  }));
}
