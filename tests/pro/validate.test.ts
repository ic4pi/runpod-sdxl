/** Numeric-token rejection and the other output guards. INPUTS ARE SYNTHETIC METRIC VALUES; no audio and no real model. */
import { describe, expect, it } from "vitest";
import { profileValueAtPct } from "../../lib/decision/evaluate";
import { tier1FallbackItems } from "../../lib/pro/findings";
import type { PhrasedItem, PhrasingPayload } from "../../lib/pro/schema";
import { collectAllowed, extractNumericTokens, validatePhrasing } from "../../lib/pro/validate";
import { ABSENT, metricsTripping, payloadFrom, THREE_FINDINGS, trap } from "./helpers";

const out = (items: PhrasedItem[]) => ({ items });
const withText = (payload: PhrasingPayload, field: keyof Omit<PhrasedItem, "coaching_id">, text: string, index = 0) => {
  const items = tier1FallbackItems(payload).map((i) => ({ ...i }));
  items[index]![field] = text;
  return out(items);
};
const kinds = (v: ReturnType<typeof validatePhrasing>) => (v.ok ? [] : v.violations.map((x) => x.kind));

describe("sanity: Tier 1's own text always validates (so a fallback can never itself be rejected)", () => {
  it("the fallback items for a payload pass the validator", () => {
    const p = THREE_FINDINGS();
    expect(p.detected_findings.length).toBe(3);
    const v = validatePhrasing(p, out(tier1FallbackItems(p)));
    expect(v.ok, JSON.stringify(v)).toBe(true);
  });
});

describe("HALLUCINATED NUMBERS ARE REJECTED", () => {
  const p = THREE_FINDINGS();
  const allowed = collectAllowed(p);
  const sib = p.detected_findings.find((f) => f.coaching_id === "sibilance_high")!; // a dB finding
  const sibIdx = p.detected_findings.indexOf(sib);

  it("a number that is nowhere in the input is rejected, wherever it appears", () => {
    for (const field of ["headline", "explanation", "suggested_move"] as const) {
      const v = validatePhrasing(p, withText(p, field, `Roughly ${ABSENT} would fix it.`));
      expect(v.ok, field).toBe(false);
      expect(v.ok ? [] : v.violations.map((x) => x.detail)).toContain(`"${ABSENT}" is not a number in the input`);
    }
  });

  it("invented advice amounts are rejected: 'cut 6 dB', 'around 2000 Hz', 'a 4 kHz notch'", () => {
    for (const bad of ["Cut 6.5 dB at the top.", "Look around 2000 Hz.", "Try a 4.4 kHz notch.", "Aim for -14 LUFS."]) {
      expect(validatePhrasing(p, withText(p, "explanation", bad)).ok, bad).toBe(false);
    }
  });

  it("a rounded or altered copy of a real number is rejected (no rounding, no arithmetic)", () => {
    const real = sib.delta; // e.g. +4.2
    expect(allowed.any.has(Math.abs(real))).toBe(true);
    const rounded = Math.round(Math.abs(real));
    if (!allowed.any.has(rounded)) expect(validatePhrasing(p, withText(p, "explanation", `Your level is about ${rounded} dB over.`, sibIdx)).ok).toBe(false);
    expect(validatePhrasing(p, withText(p, "explanation", `Your level is ${(Math.abs(real) + 0.1).toFixed(1)} dB over.`, sibIdx)).ok).toBe(false);
  });

  it("the same number is accepted when it IS in the input, with or without sign, in any field", () => {
    const real = Math.abs(sib.delta);
    expect(validatePhrasing(p, withText(p, "explanation", `It sits ${real} dB over the reference.`, sibIdx)).ok).toBe(true);
    expect(validatePhrasing(p, withText(p, "explanation", `It sits -${real} dB under, then +${real} dB over.`, sibIdx)).ok).toBe(true);
    expect(validatePhrasing(p, withText(p, "headline", `${real} dB off`, sibIdx)).ok).toBe(true);
    expect(validatePhrasing(p, withText(p, "explanation", `It sits ${real.toFixed(2)} dB over.`, sibIdx)).ok).toBe(true); // 4.20 == 4.2
    // ...but not in the unit of a different finding: the clipping delta is a ratio, not decibels
    const clip = p.detected_findings.find((f) => f.coaching_id === "clipping_present")!;
    expect(validatePhrasing(p, withText(p, "explanation", `${clip.delta} dB of clipping`, p.detected_findings.indexOf(clip))).ok).toBe(false);
    expect(validatePhrasing(p, withText(p, "explanation", `${clip.delta} of the samples are clipped`, p.detected_findings.indexOf(clip))).ok).toBe(true);
  });

  it("is unit-aware: a number from a frequency is not valid as a decibel amount (and vice versa)", () => {
    // the sibilance label contains "5-9 kHz": 5 and 9 exist as kHz numbers, not as dB numbers
    expect(allowed.byUnit.get("khz")?.has(5)).toBe(true);
    expect(allowed.byUnit.get("db")?.has(5)).toBeFalsy();
    expect(validatePhrasing(p, withText(p, "explanation", "Pull the highs down by 5 dB.")).ok).toBe(false);
    expect(validatePhrasing(p, withText(p, "explanation", "This is the 5-9 kHz region.")).ok).toBe(true);
    expect(validatePhrasing(p, withText(p, "explanation", "Cut a 2-9 dB range.")).ok).toBe(false);
  });

  it("identifier fields are NOT a source of allowed numbers ('sibilance_5k9k_rel_db' does not whitelist 3 or 250)", () => {
    expect(allowed.any.has(250)).toBe(false);
    expect(allowed.any.has(3)).toBe(false);
    expect(allowed.corpus).not.toMatch(/sibilance_5k9k/);
  });

  it("Unicode tricks: unicode minus and en dash ranges are read, full-width and superscript digits are normalised, foreign numerals are rejected", () => {
    expect(extractNumericTokens("−4.5 dB").map((t) => t.value)).toEqual([4.5]);
    expect(extractNumericTokens("2–3 dB").map((t) => [t.value, t.unit])).toEqual([[2, "db"], [3, "db"]]); // a range shares the unit after it
    expect(extractNumericTokens("４.２ dB").map((t) => t.value)).toEqual([4.2]); // full-width
    expect(extractNumericTokens("1,200 Hz")[0]).toMatchObject({ value: 1200, unit: "hz" }); // thousands separator
    expect(extractNumericTokens("3,5 kHz")[0]).toMatchObject({ value: 3.5, unit: "khz" }); // decimal comma
    expect(extractNumericTokens("50% of takes")[0]).toMatchObject({ value: 50, unit: "pct" });
    expect(extractNumericTokens("120 events/min")[0]).toMatchObject({ value: 120, unit: "events" });
    expect(extractNumericTokens("½ a dB").map((t) => t.value)).toEqual([1, 2]); // NFKC: 1⁄2
    expect(validatePhrasing(p, withText(p, "explanation", "About ٣ dB too much.")).ok).toBe(false); // Arabic-Indic digit
    expect(kinds(validatePhrasing(p, withText(p, "explanation", "About ٣ dB too much.")))).toContain("non-ascii-digit");
    expect(validatePhrasing(p, withText(p, "explanation", "About ４ dB too much.")).ok).toBe(false); // full-width, normalised then checked
  });

  it("spelled-out numbers are rejected unless the word is in the input", () => {
    for (const bad of ["Cut three decibels.", "That is twice as loud.", "Drop it by half.", "Try a hundred hertz."]) {
      const v = validatePhrasing(p, withText(p, "explanation", bad));
      expect(v.ok, bad).toBe(false);
      expect(kinds(v)).toContain("number-word");
    }
    expect(validatePhrasing(p, withText(p, "explanation", "Small changes, one step at a time.")).ok).toBe(true);
  });

  it("digits inside words are still numbers (3k5, mp3)", () => {
    expect(validatePhrasing(p, withText(p, "explanation", `Look near ${ABSENT}k5.`)).ok).toBe(false);
  });

  it("reports which number, in which field", () => {
    const v = validatePhrasing(p, withText(p, "suggested_move", `Cut ${ABSENT} dB.`, 1));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.violations[0]).toMatchObject({ kind: "number", field: "items[1].suggested_move" });
      expect(v.violations[0]!.detail).toContain(String(ABSENT));
    }
  });
});

describe("the model may only talk about the findings it was given", () => {
  const p = THREE_FINDINGS();
  const base = tier1FallbackItems(p);

  it("a coaching_id outside the request is rejected (even though it is a valid enum value)", () => {
    const items = [...base, { coaching_id: "lufs_over" as const, headline: "Too loud", explanation: "x".repeat(20), suggested_move: "y".repeat(20) }];
    expect(kinds(validatePhrasing(p, out(items)))).toContain("id");
  });
  it("a made-up coaching_id fails the schema (fixed enum)", () => {
    const items = base.map((i, n) => (n === 0 ? { ...i, coaching_id: "made_up_issue" } : i));
    const v = validatePhrasing(p, { items });
    expect(v.ok).toBe(false);
    expect(kinds(v)).toContain("shape");
  });
  it("missing and duplicated ids are rejected", () => {
    expect(kinds(validatePhrasing(p, out(base.slice(1))))).toContain("id");
    expect(kinds(validatePhrasing(p, out([...base, base[0]!])))).toContain("id");
  });
  it("topic guard: raising a defect that is not among the findings is rejected", () => {
    const hum = validatePhrasing(p, withText(p, "explanation", "Your room noise is also making this worse."));
    expect(hum.ok).toBe(false);
    expect(kinds(hum)).toContain("topic");
    expect(validatePhrasing(p, withText(p, "explanation", "The boxy muddy low end needs a cut.")).ok).toBe(false);
  });
  it("topic guard: the same word is fine when the finding itself is about it", () => {
    expect(validatePhrasing(p, withText(p, "explanation", "The clipping distorts your peaks.")).ok).toBe(true); // clipping IS a finding
  });
  it("URLs are rejected", () => {
    expect(kinds(validatePhrasing(p, withText(p, "explanation", "See https://example.com for more.")))).toContain("url");
  });
  it("shape: extra keys, empty or too-long strings, non-object output", () => {
    expect(validatePhrasing(p, { items: base, extra: 1 }).ok).toBe(false);
    expect(validatePhrasing(p, out(base.map((i) => ({ ...i, headline: "" })))).ok).toBe(false);
    expect(validatePhrasing(p, out(base.map((i) => ({ ...i, explanation: "x".repeat(421) })))).ok).toBe(false);
    expect(validatePhrasing(p, "not json object").ok).toBe(false);
    expect(validatePhrasing(p, null).ok).toBe(false);
  });
});

describe("a second payload (presence + boxiness): frequency numbers from labels are usable, others are not", () => {
  const p = payloadFrom(
    metricsTripping({
      presence_3k5_rel_db: profileValueAtPct(trap, "presence_3k5_rel_db", 10) - 2.6,
      boxiness_250hz_rel_db: profileValueAtPct(trap, "boxiness_250hz_rel_db", 90) + 3.3,
    }),
  );
  it("'250 Hz' and '3.5 kHz' come from the input; '300 Hz' does not", () => {
    expect(p.coaching_ids.sort()).toEqual(["boxiness_high", "presence_low"]);
    expect(validatePhrasing(p, withText(p, "explanation", "The region around 250 Hz and the one at 3.5 kHz.")).ok).toBe(true);
    expect(validatePhrasing(p, withText(p, "explanation", "The region around 300 Hz.")).ok).toBe(false);
  });
});
