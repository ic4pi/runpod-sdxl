import claims from "./claims.json";
import type { Finding, PhrasedItem, PhrasingPayload } from "./schema";
import type { Violation } from "./validate";

/**
 * Pins the model's ADVICE and CLAIMS to Tier 1's text. The numeric validator cannot see a claim that has no number
 * ("your vocal sounds thin"); these three guards close what a closed vocabulary can close:
 *   1. suggested_move must be Tier 1's suggested_move for that coaching_id, character for character (after whitespace normalisation).
 *      "Contains it verbatim" is NOT accepted: that would let the model append new advice after the real advice.
 *   2. headline and explanation may not use an advice/imperative word from the closed list unless Tier 1's text for that finding uses it.
 *   3. headline and explanation may not use a sound-quality/defect word from the closed list, nor assert something with a perception
 *      frame ("sounds X", "feels X", "there is X", "is too X", "lacks X"), unless the words involved are in Tier 1's text for that finding.
 * Residual gap (documented, tested as such): a claim built only from words outside these lists, with no number, no listed frame and
 * no listed topic ("your vocal lacks life") is not caught here.
 */

const compile = (sources: readonly string[]) => sources.map((s) => new RegExp(`(?<![\\w-])(?:${s})(?![\\w-])`, "gi"));
const IMPERATIVES = compile(claims.imperatives);
const DESCRIPTORS = compile(claims.descriptors);
const FRAMES = claims.perception_frames.map((s) => new RegExp(`(?<![\\w-])(?:${s})(?![\\w-])`, "gi"));
const STOP = new Set(claims.stopwords);

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();
const stem = (w: string) => w.toLowerCase().replace(/[^a-z]/g, "").slice(0, 5);
const words = (s: string) => s.normalize("NFKC").toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];

/** Everything Tier 1 itself said about this finding. */
export const tier1TextOf = (f: Finding): string => `${f.tier1.title}\n${f.tier1.message}\n${f.tier1.suggested_move}\n${f.metric_label}`;

const hits = (res: readonly RegExp[], text: string): string[] => {
  const out: string[] = [];
  for (const re of res) for (const m of text.normalize("NFKC").matchAll(re)) out.push(m[0].toLowerCase().replace(/\s+/g, " "));
  return out;
};
/** Is this exact phrase-pattern match also produced by Tier 1's text? (compare by the same pattern, not the raw word: "pulls" ~ "pull") */
const sameFamilyIn = (res: readonly RegExp[], word: string, tier1: string): boolean => {
  const hit = res.find((re) => ((re.lastIndex = 0), new RegExp(re.source, "i").test(word)));
  return !!hit && new RegExp(hit.source, "i").test(tier1.normalize("NFKC"));
};

const fieldsOf = (it: PhrasedItem) => [
  ["headline", it.headline],
  ["explanation", it.explanation],
] as const;

export function pinMoveViolations(payload: PhrasingPayload, items: readonly PhrasedItem[]): Violation[] {
  const byId = new Map(payload.detected_findings.map((f) => [f.coaching_id, f]));
  const out: Violation[] = [];
  items.forEach((it, n) => {
    const f = byId.get(it.coaching_id);
    if (!f) return; // id problems are reported by the id check
    if (norm(it.suggested_move) !== norm(f.tier1.suggested_move)) {
      out.push({ kind: "pinned-move", field: `items[${n}].suggested_move`, detail: `suggested_move for "${it.coaching_id}" must be copied exactly from the input: "${f.tier1.suggested_move}"` });
    }
  });
  return out;
}

export function imperativeViolations(payload: PhrasingPayload, items: readonly PhrasedItem[]): Violation[] {
  const byId = new Map(payload.detected_findings.map((f) => [f.coaching_id, f]));
  const out: Violation[] = [];
  items.forEach((it, n) => {
    const f = byId.get(it.coaching_id);
    if (!f) return;
    const t1 = tier1TextOf(f);
    for (const [name, text] of fieldsOf(it)) {
      for (const w of new Set(hits(IMPERATIVES, text))) {
        if (!sameFamilyIn(IMPERATIVES, w, t1)) out.push({ kind: "imperative", field: `items[${n}].${name}`, detail: `advice word "${w}" is not in the input text for "${it.coaching_id}"; advice belongs only in the pinned suggested_move` });
      }
    }
  });
  return out;
}

export function claimViolations(payload: PhrasingPayload, items: readonly PhrasedItem[]): Violation[] {
  const byId = new Map(payload.detected_findings.map((f) => [f.coaching_id, f]));
  const out: Violation[] = [];
  items.forEach((it, n) => {
    const f = byId.get(it.coaching_id);
    if (!f) return;
    const t1 = tier1TextOf(f);
    const t1Stems = new Set(words(t1).map(stem));
    for (const [name, text] of fieldsOf(it)) {
      const field = `items[${n}].${name}`;
      for (const w of new Set(hits(DESCRIPTORS, text))) {
        if (!sameFamilyIn(DESCRIPTORS, w, t1)) out.push({ kind: "claim-word", field, detail: `"${w}" describes the sound but is not in the input text for "${it.coaching_id}"` });
      }
      const flat = text.normalize("NFKC");
      for (const re of FRAMES) {
        for (const m of flat.matchAll(re)) {
          const after = flat.slice(m.index! + m[0].length).split(/[.;:!?\n]/)[0]!;
          const content = words(after).filter((w) => w.length >= 3 && !STOP.has(w)).slice(0, 3);
          const bad = content.filter((w) => !t1Stems.has(stem(w)));
          if (bad.length) out.push({ kind: "claim-frame", field, detail: `"${m[0].toLowerCase()} ${content.join(" ")}" asserts something not in the input text for "${it.coaching_id}" (${bad.join(", ")})` });
        }
      }
    }
  });
  return out;
}

export const pinningViolations = (payload: PhrasingPayload, items: readonly PhrasedItem[]): Violation[] => [
  ...pinMoveViolations(payload, items),
  ...imperativeViolations(payload, items),
  ...claimViolations(payload, items),
];
