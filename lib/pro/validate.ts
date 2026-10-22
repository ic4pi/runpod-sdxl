import topicsJson from "./topics.json";
import { pinningViolations } from "./pinning";
import { LlmOutputSchema, type PhrasedItem, type PhrasingPayload } from "./schema";

/**
 * Post-validation of the model's output. The LLM may only REPHRASE: everything it states must already be in its input.
 *
 * Numeric-token rule (the core one): extract every numeric token from headline / explanation / suggested_move.
 *  - Text is NFKC-normalised first (full-width digits, superscripts, vulgar fractions become ASCII digits).
 *  - Any digit from another script (Arabic-Indic, Devanagari, ...) is rejected outright.
 *  - Tokens are digit runs: "3.2", "250", "1,200" (thousands), "3,5" (decimal comma). A range "2-3" is two tokens. Sign is ignored (magnitude).
 *  - A token's value must equal a number that appears in the input: either a numeric field, or a numeral inside the input's display text.
 *    Identifier fields (rule_id, coaching_id, metric_id, ...) are NOT scanned, so "sibilance_5k9k" does not whitelist a 5 or a 9.
 *  - Unit-aware: a token followed by a unit (Hz, kHz, dB/LU/dBTP/dBFS, LUFS, %, ms, s, events/min) must match an input number used with
 *    the SAME unit family (dB and LU share one family: 1 LU = 1 dB). "5 dB" is rejected when the input only has "5 kHz".
 *  - No conversion, rounding or arithmetic is allowed: "3 dB" is rejected when the input says 3.2.
 *  - Spelled-out numbers (two ... ninety, hundred, half, twice, double, ...) are rejected unless that word is in the input. ("one" is not
 *    checked: too common in plain prose. Known gap.)
 * Other guards: output ids must equal the request's coaching_ids (each exactly once, none extra); a topic guard rejects talk about a
 * defect that is not among the request's findings; URLs are rejected.
 * It cannot catch a paraphrased NEW claim that uses no number and no topic word ("your vocal sounds thin"). The prompt forbids it; this does not enforce it.
 */

export type ViolationKind = "shape" | "id" | "number" | "number-word" | "non-ascii-digit" | "topic" | "url" | "pinned-move" | "imperative" | "claim-word" | "claim-frame";
export interface Violation {
  kind: ViolationKind;
  detail: string;
  field?: string;
}
export type Validation = { ok: true; items: PhrasedItem[] } | { ok: false; violations: Violation[] };

export type Unit = "khz" | "hz" | "db" | "lufs" | "pct" | "ms" | "events" | "sec";
export interface NumericToken {
  raw: string;
  value: number;
  unit: Unit | null;
  index: number;
}

const NUM_RUN = /\d+(?:[.,]\d+)*/g;
const UNIT_RE = /^(?:\s*(?:-|–|—|to|and)\s*\d+(?:[.,]\d+)?)?\s*(khz|hz|dbtp|dbfs|db|lufs|lu\b|%|ms\b|events\s*(?:\/|per)\s*min(?:ute)?|seconds?|sec\b|s\b)/i;
const NUMBER_WORDS =
  /\b(zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half|twice|double|doubled|triple|tripled|quarter|dozen)\b/gi;
/** Keys whose string values are identifiers, not display text: never a source of allowed numbers or topic words. */
const ID_KEY = /(^|_)id$|^coaching_ids$|^schema_version$|^reference_genre$/;

const norm = (v: number): number => Math.round(Math.abs(v) * 1e6) / 1e6;

function unitOf(s: string): Unit {
  const t = s.toLowerCase().replace(/\s+/g, "");
  if (t === "khz") return "khz";
  if (t === "hz") return "hz";
  if (t === "lufs") return "lufs";
  if (t === "%") return "pct";
  if (t === "ms") return "ms";
  if (t.startsWith("events")) return "events";
  if (t === "s" || t === "sec" || t.startsWith("second")) return "sec";
  return "db"; // db, dbtp, dbfs, lu
}

function parseRun(run: string): number[] {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(run)) return [Number(run.replace(/,/g, ""))];
  if (/^\d+[.,]\d+$/.test(run)) return [Number(run.replace(",", "."))];
  return run.split(/[.,]/).map(Number);
}

/** Every numeric token in `text` (after NFKC), with the unit that follows it if any. */
export function extractNumericTokens(text: string): NumericToken[] {
  const t = text.normalize("NFKC");
  const out: NumericToken[] = [];
  for (const m of t.matchAll(NUM_RUN)) {
    const values = parseRun(m[0]);
    const after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
    const u = UNIT_RE.exec(after);
    values.forEach((value, i) => out.push({ raw: m[0], value, unit: i === values.length - 1 && u ? unitOf(u[1]!) : null, index: m.index! }));
  }
  return out;
}

const hasForeignDigit = (s: string): boolean => [...s.normalize("NFKC")].some((c) => /\p{Nd}/u.test(c) && !/[0-9]/.test(c));

export interface Allowed {
  any: Set<number>;
  byUnit: Map<Unit, Set<number>>;
  words: Set<string>;
  /** All display text of the input, for the topic guard. */
  corpus: string;
}

function unitFromField(u: unknown): Unit | null {
  if (u === "dB" || u === "LU") return "db";
  if (u === "events/min") return "events";
  return null; // "ratio" and unknown: unitless
}

/** Numbers and display text present in the payload (identifier fields excluded). */
export function collectAllowed(payload: PhrasingPayload): Allowed {
  const a: Allowed = { any: new Set(), byUnit: new Map(), words: new Set(), corpus: "" };
  const add = (v: number, unit: Unit | null) => {
    a.any.add(norm(v));
    if (unit) {
      if (!a.byUnit.has(unit)) a.byUnit.set(unit, new Set());
      a.byUnit.get(unit)!.add(norm(v));
    }
  };
  const corpus: string[] = [];
  const walk = (node: unknown, key: string, siblingUnit: Unit | null): void => {
    if (typeof node === "number") return add(node, siblingUnit);
    if (typeof node === "string") {
      if (ID_KEY.test(key) || key === "delta_unit" || key === "unit") return;
      corpus.push(node);
      for (const tok of extractNumericTokens(node)) add(tok.value, tok.unit);
      for (const w of node.toLowerCase().match(/[a-z']+/g) ?? []) a.words.add(w);
      return;
    }
    if (Array.isArray(node)) return node.forEach((x) => walk(x, key, siblingUnit));
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      const u = unitFromField(o["delta_unit"] ?? o["unit"]) ?? siblingUnit;
      for (const [k, v] of Object.entries(o)) walk(v, k, k === "delta" || k === "unit" ? u : null);
    }
  };
  walk(payload, "", null);
  a.corpus = corpus.join("\n");
  return a;
}

const topicRegexes = Object.entries(topicsJson.topics as Record<string, string[]>).map(
  ([id, terms]) => [id, terms.map((t) => new RegExp(t, "i"))] as const,
);

const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Extra = (payload: PhrasingPayload, items: readonly PhrasedItem[]) => Violation[];

/**
 * The full production validator: numeric/id/topic/url checks PLUS the pinning guards (pinned suggested_move, advice-word guard,
 * claim guard; see pinning.ts).
 * @param raw the model's parsed JSON (unknown shape)
 */
export const validatePhrasing = (payload: PhrasingPayload, raw: unknown): Validation => validateWith(payload, raw, pinningViolations);

/** What Phase 5 shipped: everything EXCEPT the pinning guards. Kept exported so tests can prove the pinning guards are load-bearing. Not used in production. */
export const validateWithoutPinning = (payload: PhrasingPayload, raw: unknown): Validation => validateWith(payload, raw, () => []);

function validateWith(payload: PhrasingPayload, raw: unknown, extra: Extra): Validation {
  const parsed = LlmOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: parsed.error.issues.slice(0, 5).map((i) => ({ kind: "shape", detail: `${i.path.join(".") || "(root)"}: ${i.message}` })) };
  }
  const items = parsed.data.items;
  const violations: Violation[] = [];

  // ids: exactly the request's coaching_ids, each once
  const want = new Set<string>(payload.coaching_ids);
  const seen = new Set<string>();
  for (const it of items) {
    if (!want.has(it.coaching_id)) violations.push({ kind: "id", detail: `coaching_id "${it.coaching_id}" was not in the request` });
    if (seen.has(it.coaching_id)) violations.push({ kind: "id", detail: `coaching_id "${it.coaching_id}" appears more than once` });
    seen.add(it.coaching_id);
  }
  for (const id of want) if (!seen.has(id)) violations.push({ kind: "id", detail: `coaching_id "${id}" is missing` });

  const allowed = collectAllowed(payload);
  const fields = items.flatMap((it, n) =>
    (["headline", "explanation", "suggested_move"] as const).map((f) => ({ field: `items[${n}].${f}`, text: it[f] })),
  );

  for (const { field, text } of fields) {
    if (hasForeignDigit(text)) violations.push({ kind: "non-ascii-digit", detail: `digit from a non-Latin numeral system: "${short(text, 40)}"`, field });
    if (/https?:\/\/|www\./i.test(text)) violations.push({ kind: "url", detail: "URLs are not allowed", field });
    for (const tok of extractNumericTokens(text)) {
      const v = norm(tok.value);
      const ok = tok.unit ? (allowed.byUnit.get(tok.unit)?.has(v) ?? false) : allowed.any.has(v);
      if (!ok) {
        violations.push({
          kind: "number",
          detail: tok.unit
            ? `"${tok.raw}" (${tok.unit}) is not a ${tok.unit} number in the input`
            : `"${tok.raw}" is not a number in the input`,
          field,
        });
      }
    }
    for (const m of text.matchAll(NUMBER_WORDS)) {
      if (!allowed.words.has(m[0].toLowerCase())) violations.push({ kind: "number-word", detail: `number word "${m[0]}" is not in the input`, field });
    }
  }

  // topic guard
  const all = fields.map((f) => f.text).join("\n");
  for (const [id, res] of topicRegexes) {
    if (want.has(id)) continue;
    for (const re of res) {
      if (re.test(all) && !re.test(allowed.corpus)) violations.push({ kind: "topic", detail: `mentions the topic of "${id}" (matched /${re.source}/), which is not among the findings` });
    }
  }

  violations.push(...extra(payload, items));
  return violations.length === 0 ? { ok: true, items } : { ok: false, violations: dedupe(violations).slice(0, 12) };
}

function dedupe(vs: Violation[]): Violation[] {
  const seen = new Set<string>();
  return vs.filter((v) => {
    const k = `${v.kind}|${v.detail}|${v.field ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Compact feedback for a retry prompt. Mentions the offending tokens, never supplies new numbers. */
export function describeViolations(vs: readonly Violation[]): string {
  return vs.map((v) => `- ${v.kind}${v.field ? ` (${v.field})` : ""}: ${v.detail}`).join("\n");
}
