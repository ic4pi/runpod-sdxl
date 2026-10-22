import { z } from "zod";
import { PRO_CONFIG } from "./config";
import { canonicalJson } from "./hash";
import { LlmOutputSchema, type PhrasingPayload } from "./schema";
import { describeViolations, type Violation } from "./validate";

/** Stable text: no dates, ids or per-request data (keeps the prompt cacheable and the cache key honest). Bump PRO_CONFIG.promptVersion when editing. */
export const SYSTEM_PROMPT = `You are a copy editor for a vocal-recording coaching app used by amateur rappers.
A deterministic engine has already measured the track, compared it with a reference, and decided what to tell the user. You receive its decisions as JSON. Your only job is to say the same things in clearer, friendlier words.

You must:
1. Return one item for every coaching_id in the input, exactly once, and no other coaching_id.
2. Rewrite each finding from its tier1 text. Keep its meaning, its direction (above or below the reference) and its advice. Plain, direct, conversational English. No hype.
3. Use a number only if it appears in the input, copied exactly as written (same digits). Do not round, convert units, add, subtract, average, estimate or compute anything. Do not introduce any other number: no step counts, percentages, frequencies, decibel amounts, ranges, years or examples. Do not write numbers as words.
4. Mention only the problem, metric and fix named in that finding's own input. Do not mention any other problem, do not diagnose, do not add new advice, and do not add tips from your own knowledge.
5. If reference_is_placeholder is true, do not claim how real records of the genre sound. The comparison is a demonstration.
6. Plain text only: no markdown, lists, emojis, links or quotation marks around the whole text.

Return only the JSON object described by the schema.`;

export function buildUserMessage(payload: PhrasingPayload): string {
  return `Rewrite these findings.\n\n${canonicalJson(payload)}`;
}

/** Retry turn: tells the model exactly what was rejected. It never supplies numbers of its own. */
export function buildRetryMessage(violations: readonly Violation[]): string {
  return `Your previous answer was rejected by an automatic check:\n${describeViolations(violations)}\n\nReturn the corrected JSON. Use only numbers that appear in the input, exactly as written, and mention only what the findings contain.`;
}

/** JSON Schema of the structured output (what the API is told to constrain the response to). */
export function outputJsonSchema(): unknown {
  return z.toJSONSchema(LlmOutputSchema, { target: "draft-2020-12" });
}

export const PROMPT_META = { version: PRO_CONFIG.promptVersion, model: PRO_CONFIG.model } as const;
