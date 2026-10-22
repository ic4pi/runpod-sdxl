import { DEFAULT_CONTEXT } from "../decision/default";
import { formatDelta } from "../decision/evaluate";
import { PROFILES } from "../reference/profiles";
import type { PhrasingPayload } from "./schema";

/**
 * The payload arrives from the browser, so its text is attacker-controlled. Everything the pinning guards treat as "Tier 1's own words"
 * must therefore be words Tier 1 could actually have produced. This recomputes every string from the authored data (decision table,
 * coaching copy, metric registry, reference profiles) and the finding's numbers, and reports each mismatch. Any mismatch => HTTP 400,
 * no model call.
 * What it cannot verify: that the delta VALUES are real measurements (they come from the user's audio, measured in their browser).
 * A forged delta only makes Tier 1's own canned text mention a different number to its sender.
 */
export function canonicalViolations(p: PhrasingPayload): string[] {
  const out: string[] = [];
  const profile = PROFILES.find((x) => x.id === p.reference_genre);
  if (!profile) out.push(`reference_genre "${p.reference_genre}" is not a known profile`);
  else {
    if (p.reference_genre_label !== profile.label) out.push("reference_genre_label does not match the profile");
    if (p.reference_is_placeholder !== profile._placeholder) out.push("reference_is_placeholder does not match the profile");
  }
  const rules = new Map(DEFAULT_CONTEXT.rules.map((r) => [r.id, r]));
  const metrics = new Map(DEFAULT_CONTEXT.metrics.map((m) => [m.id, m]));
  for (const f of p.detected_findings) {
    const at = `finding ${f.coaching_id}`;
    const rule = rules.get(f.rule_id);
    const def = metrics.get(f.metric_id);
    const copy = DEFAULT_CONTEXT.coaching[f.coaching_id];
    if (!rule || !def || !copy) {
      out.push(`${at}: unknown rule, metric or coaching copy`);
      continue;
    }
    if (rule.coaching_id !== f.coaching_id || rule.metric !== f.metric_id) out.push(`${at}: rule/metric/coaching_id do not belong together`);
    if (rule.direction !== f.direction || rule.severity !== f.severity) out.push(`${at}: direction or severity differs from the rule`);
    if (def.delta_unit !== f.delta_unit) out.push(`${at}: delta_unit differs from the metric`);
    if (f.metric_label !== def.label) out.push(`${at}: metric_label differs from the metric`);
    if (f.tier1.title !== copy.title) out.push(`${at}: title is not Tier 1's title`);
    if (f.tier1.suggested_move !== rule.suggested_move) out.push(`${at}: suggested_move is not Tier 1's suggested_move`);
    const message = copy.explanation
      .replaceAll("{delta}", formatDelta(f.delta, def.delta_unit))
      .replaceAll("{unit}", def.delta_unit)
      .replaceAll("{profile}", profile?.label ?? p.reference_genre_label);
    if (f.tier1.message !== message) out.push(`${at}: message is not Tier 1's message for this delta`);
    const md = p.metric_deltas[f.metric_id];
    if (!md || md.delta !== f.delta || md.unit !== f.delta_unit || md.label !== f.metric_label) out.push(`${at}: metric_deltas entry differs from the finding`);
  }
  const keys = Object.keys(p.metric_deltas).sort().join(",");
  const want = [...new Set(p.detected_findings.map((f) => f.metric_id))].sort().join(",");
  if (keys !== want) out.push("metric_deltas has entries that are not findings");
  return out;
}
