/** Payload builder + schemas + prompt. SYNTHETIC METRICS only. */
import { describe, expect, expectTypeOf, it } from "vitest";
import coachingJson from "../../lib/decision/coaching.json";
import { DEFAULT_CONTEXT } from "../../lib/decision/default";
import { evaluate, profileValueAtPct } from "../../lib/decision/evaluate";
import { PRO_CONFIG } from "../../lib/pro/config";
import { buildPhrasingPayload, tier1FallbackItems } from "../../lib/pro/findings";
import { canonicalJson, sha256Hex } from "../../lib/pro/hash";
import { buildUserMessage, outputJsonSchema, SYSTEM_PROMPT } from "../../lib/pro/prompt";
import { COACHING_IDS, LlmOutputSchema, PhrasingPayloadSchema, PhrasingRequestSchema, PhrasingResultSchema } from "../../lib/pro/schema";
import topics from "../../lib/pro/topics.json";
import { PROFILES } from "../../lib/reference/profiles";
import { metricsAtMedian, metricsTripping, payloadFrom, THREE_FINDINGS, trap } from "./helpers";

describe("input payload builder (Tier 1 -> LLM input)", () => {
  it("NO REFERENCE => no payload at all (so no call can be made)", () => {
    const r = evaluate(null, metricsAtMedian());
    expect(buildPhrasingPayload(r)).toEqual({ ok: false, reason: "no-reference" });
  });

  it("a reference with nothing beyond thresholds => nothing to phrase", () => {
    expect(buildPhrasingPayload(evaluate(trap, metricsAtMedian()))).toEqual({ ok: false, reason: "nothing-to-phrase" });
  });

  it("contains exactly what the architecture names: findings, metric deltas, reference genre, coaching ids", () => {
    const p = THREE_FINDINGS();
    expect(Object.keys(p).sort()).toEqual(["coaching_ids", "detected_findings", "metric_deltas", "reference_genre", "reference_genre_label", "reference_is_placeholder", "schema_version"]);
    expect(p.reference_genre).toBe("trap");
    expect(p.reference_is_placeholder).toBe(true);
    expect(p.coaching_ids.sort()).toEqual(["clipping_present", "plosive_detected", "sibilance_high"]);
    expect(Object.keys(p.metric_deltas).sort()).toEqual(["clipped_sample_ratio", "plosive_events_per_min", "sibilance_5k9k_rel_db"]);
    expect(() => PhrasingPayloadSchema.parse(p)).not.toThrow();
  });

  it("every number is a rounded delta that also appears as that exact token in Tier 1's text; no profile absolute value is present", () => {
    const p = THREE_FINDINGS();
    for (const f of p.detected_findings) {
      const shown = String(Math.abs(f.delta));
      expect(`${f.tier1.message}`.includes(shown) || f.tier1.message.includes(Math.abs(f.delta).toFixed(1)) || f.tier1.message.includes(Math.abs(f.delta).toPrecision(2)), `${f.coaching_id} ${f.delta}`).toBe(true);
    }
    const nums = new Set<number>();
    (function walk(x: unknown) {
      if (typeof x === "number") nums.add(x);
      else if (x && typeof x === "object") Object.values(x).forEach(walk);
    })(p);
    for (const m of Object.values(trap.metrics)) for (const v of m.values) if (v !== 0) expect(nums.has(v), `profile value ${v} leaked`).toBe(false);
  });

  it("carries Tier 1's own wording for each finding", () => {
    const p = THREE_FINDINGS();
    const r = evaluate(trap, metricsTripping({ plosive_events_per_min: 9.2 }));
    if (r.kind !== "evaluated") throw new Error("x");
    const line = r.coaching.find((c) => c.ruleId === "plosive_detected")!;
    const f = payloadFrom(metricsTripping({ plosive_events_per_min: 9.2 })).detected_findings[0]!;
    expect(f.tier1).toEqual({ title: line.title, message: line.message, suggested_move: line.suggestedMove });
    expect(p.detected_findings.length).toBe(3);
  });

  it("one finding per coaching_id even if two rules share it; capped at maxFindings", () => {
    const everything = Object.fromEntries(DEFAULT_CONTEXT.rules.map((r) => [r.metric, profileValueAtPct(trap, r.metric, r.threshold_pct) + (r.direction === "above" ? 1 : -1) * 0.5]));
    const p = payloadFrom(metricsTripping(everything));
    expect(p.coaching_ids.length).toBe(new Set(p.coaching_ids).size);
    expect(p.detected_findings.length).toBeLessThanOrEqual(PRO_CONFIG.limits.maxFindings);
    expect(p.detected_findings.length).toBeGreaterThanOrEqual(8);
  });

  it("EVERY shipped reference profile (incl. hyphenated ids like boom-bap) builds a valid payload and never throws", () => {
    for (const prof of PROFILES) {
      const everything = Object.fromEntries(DEFAULT_CONTEXT.rules.map((r) => [r.metric, profileValueAtPct(prof, r.metric, r.threshold_pct) + (r.direction === "above" ? 1 : -1) * 0.5]));
      const b = buildPhrasingPayload(evaluate(prof, metricsTripping(everything)));
      expect(b.ok, prof.id).toBe(true);
      if (b.ok) {
        expect(b.payload.reference_genre).toBe(prof.id);
        expect(Object.keys(b.payload.metric_deltas).length).toBe(b.payload.detected_findings.length);
      }
    }
  });

  it("is deterministic and key-order independent (this is what the cache hashes)", async () => {
    const a = THREE_FINDINGS();
    const b = THREE_FINDINGS();
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const rev = (x: any): any => (Array.isArray(x) ? x.map(rev) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().reverse().map((k) => [k, rev(x[k])])) : x);
    const reordered = rev(a);
    expect(Object.keys(reordered)).not.toEqual(Object.keys(a));
    expect(await sha256Hex(canonicalJson(reordered))).toBe(await sha256Hex(canonicalJson(a)));
  });

  it("tier1FallbackItems = Tier 1 text in the output shape, one per finding", () => {
    const p = THREE_FINDINGS();
    const items = tier1FallbackItems(p);
    expect(items.map((i) => i.coaching_id)).toEqual(p.detected_findings.map((f) => f.coaching_id));
    expect(items[0]!.explanation).toBe(p.detected_findings[0]!.tier1.message);
  });
});

describe("schemas and the fixed enum", () => {
  it("the enum equals the coaching copy ids and the topic-guard ids (drift guard)", () => {
    expect([...COACHING_IDS].sort()).toEqual(Object.keys(coachingJson.coaching).sort());
    expect([...COACHING_IDS].sort()).toEqual(Object.keys(topics.topics).sort());
    expect([...COACHING_IDS].sort()).toEqual([...new Set(DEFAULT_CONTEXT.rules.map((r) => r.coaching_id))].sort());
  });

  it("input is strict: unknown keys, bad units, duplicate ids, mismatched coaching_ids, non-finite numbers are rejected", () => {
    const p = THREE_FINDINGS();
    const bad = (mut: (x: any) => void) => {
      const c = structuredClone(p) as any;
      mut(c);
      return PhrasingPayloadSchema.safeParse(c).success;
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((c) => (c.extra = 1))).toBe(false);
    expect(bad((c) => (c.detected_findings[0].delta_unit = "kHz"))).toBe(false);
    expect(bad((c) => (c.detected_findings[0].tier1.extra = "x"))).toBe(false);
    expect(bad((c) => c.coaching_ids.push("lufs_over"))).toBe(false);
    expect(bad((c) => (c.detected_findings[1].coaching_id = c.detected_findings[0].coaching_id))).toBe(false);
    expect(bad((c) => (c.detected_findings[0].delta = Infinity))).toBe(false);
    expect(bad((c) => (c.detected_findings[0].coaching_id = "made_up"))).toBe(false);
    expect(PhrasingRequestSchema.safeParse({ payload: p, tier: "pro" }).success).toBe(false); // .strict()
  });

  it("output coaching_id is a fixed enum; strings and lengths are bounded", () => {
    const item = { coaching_id: "presence_high", headline: "ok", explanation: "ok ok ok", suggested_move: "ok ok ok" };
    expect(LlmOutputSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(LlmOutputSchema.safeParse({ items: [{ ...item, coaching_id: "anything_else" }] }).success).toBe(false);
    expect(LlmOutputSchema.safeParse({ items: [{ ...item, headline: "x".repeat(81) }] }).success).toBe(false);
    expect(LlmOutputSchema.safeParse({ items: [] }).success).toBe(false);
    expect(LlmOutputSchema.safeParse({ items: [item], note: "hi" }).success).toBe(false);
    const js = JSON.stringify(outputJsonSchema());
    for (const id of COACHING_IDS) expect(js).toContain(id);
  });

  it("route result type is a discriminated source", () => {
    const ok = PhrasingResultSchema.safeParse({ source: "llm", items: [{ coaching_id: "crest_low", headline: "a", explanation: "b", suggested_move: "c" }], attempts: 1, prompt_version: "1", model: "m" });
    expect(ok.success).toBe(true);
    expect(PhrasingResultSchema.safeParse({ source: "magic", items: [], attempts: 0, prompt_version: "1", model: "m" }).success).toBe(false);
    expectTypeOf<ReturnType<typeof PhrasingResultSchema.parse>["source"]>().toEqualTypeOf<"llm" | "cache" | "tier1-fallback">();
  });
});

describe("prompt", () => {
  it("is stable text (no dates/ids) and states the rules the validator enforces", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/20\d\d|[0-9a-f]{16}/);
    for (const must of [/never|only|must/i, /appears in the input/i, /exactly once/i, /do not.*number|Do not introduce any other number/i, /reference_is_placeholder/]) expect(SYSTEM_PROMPT).toMatch(must);
  });
  it("the user message is the canonical payload and nothing the LLM could use to originate a finding", () => {
    const p = THREE_FINDINGS();
    expect(buildUserMessage(p)).toContain(canonicalJson(p));
    expect(buildUserMessage(p)).not.toMatch(/percentile|threshold_pct|\bP\d\d\b|profile/i);
  });
});
