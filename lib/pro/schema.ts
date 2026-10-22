import { z } from "zod";
import { PRO_CONFIG } from "./config";

/**
 * Fixed enum of everything the LLM may talk about. Mirrors lib/decision/coaching.json (a unit test fails if they drift).
 * The model can only ever return coaching_ids from this list, and only ones present in the request.
 */
export const COACHING_IDS = [
  "presence_high",
  "presence_low",
  "boxiness_high",
  "sibilance_high",
  "plosive_detected",
  "noise_floor_high",
  "clipping_present",
  "lufs_over",
  "lufs_under",
  "lra_wide",
  "true_peak_hot",
  "crest_low",
] as const;
export type CoachingId = (typeof COACHING_IDS)[number];
export const CoachingIdSchema = z.enum(COACHING_IDS);

const L = PRO_CONFIG.limits;
const text = (max: number) => z.string().min(1).max(max);
const idString = z.string().regex(/^[a-z0-9_]{1,64}$/);

/** One deterministic finding, exactly as Tier 1 produced it. All numbers are already rounded to display precision. */
export const FindingSchema = z
  .object({
    rule_id: idString,
    coaching_id: CoachingIdSchema,
    metric_id: idString,
    metric_label: text(L.maxTextChars),
    severity: z.enum(["info", "warn", "critical"]),
    /** Where the user's value sits relative to the reference. */
    direction: z.enum(["above", "below"]),
    /** Signed difference from the reference median, in `delta_unit`. */
    delta: z.number().finite(),
    delta_unit: z.enum(["dB", "LU", "ratio", "events/min"]),
    /** Tier 1's own words. The LLM rewrites these; it must not add to them. */
    tier1: z
      .object({ title: text(L.maxTextChars), message: text(L.maxTextChars), suggested_move: text(L.maxTextChars) })
      .strict(),
  })
  .strict();

/** The ONLY thing the LLM sees. */
export const PhrasingPayloadSchema = z
  .object({
    schema_version: z.literal(1),
    reference_genre: z.string().regex(/^[a-z0-9_-]{1,64}$/), // profile ids may contain hyphens (boom-bap)
    reference_genre_label: text(L.maxTextChars),
    reference_is_placeholder: z.boolean(),
    coaching_ids: z.array(CoachingIdSchema).min(1).max(L.maxFindings),
    detected_findings: z.array(FindingSchema).min(1).max(L.maxFindings),
    metric_deltas: z.record(
      idString,
      z.object({ label: text(L.maxTextChars), delta: z.number().finite(), unit: z.enum(["dB", "LU", "ratio", "events/min"]) }).strict(),
    ),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = p.detected_findings.map((f) => f.coaching_id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "one finding per coaching_id" });
    if (new Set(p.coaching_ids).size !== p.coaching_ids.length) ctx.addIssue({ code: "custom", message: "coaching_ids must be unique" });
    const a = [...ids].sort().join(",");
    const b = [...p.coaching_ids].sort().join(",");
    if (a !== b) ctx.addIssue({ code: "custom", message: "coaching_ids must list exactly the findings' coaching_ids" });
  });
export type PhrasingPayload = z.infer<typeof PhrasingPayloadSchema>;
export type Finding = z.infer<typeof FindingSchema>;

/** Request body of POST /api/phrasing. */
export const PhrasingRequestSchema = z.object({ payload: PhrasingPayloadSchema }).strict();
export type PhrasingRequest = z.infer<typeof PhrasingRequestSchema>;

/** One reworded coaching item. coaching_id is the fixed enum. */
export const PhrasedItemSchema = z
  .object({
    coaching_id: CoachingIdSchema,
    headline: text(L.headlineMaxChars),
    explanation: text(L.explanationMaxChars),
    suggested_move: text(L.suggestedMoveMaxChars),
  })
  .strict();
export type PhrasedItem = z.infer<typeof PhrasedItemSchema>;

/** What the model must return (structured output). */
export const LlmOutputSchema = z.object({ items: z.array(PhrasedItemSchema).min(1).max(L.maxFindings) }).strict();
export type LlmOutput = z.infer<typeof LlmOutputSchema>;

/** What the route returns (always 200 for a valid request, even when the model failed: it falls back to Tier 1 text). */
export const PhrasingResultSchema = z
  .object({
    source: z.enum(["llm", "cache", "tier1-fallback"]),
    items: z.array(PhrasedItemSchema).min(1).max(L.maxFindings),
    attempts: z.number().int().min(0).max(1 + PRO_CONFIG.maxRetries),
    fallback_reason: z.string().max(200).optional(),
    /** Short reasons earlier attempts were rejected (diagnostics only). */
    rejections: z.array(z.string().max(300)).max(1 + PRO_CONFIG.maxRetries).optional(),
    prompt_version: z.string(),
    model: z.string(),
  })
  .strict();
export type PhrasingResult = z.infer<typeof PhrasingResultSchema>;
