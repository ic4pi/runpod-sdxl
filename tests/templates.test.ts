import { describe, expect, it } from "vitest";
import { blendTaste, myRap, setReferenceEnabled, setReferenceMeasured, validateTemplate } from "../lib/templates";

// A copy with every measurement cleared, so blend tests control their own inputs.
const blankRap = { ...myRap, references: myRap.references.map((r) => ({ ...r, measured: null })) };

describe("my-rap template", () => {
  it("ships all seven references, all enabled", () => {
    expect(myRap.references.map((r) => r.artist)).toEqual([
      "Joyner Lucas", "Vinny Paz", "Leather Corduroys", "Doja Cat", "Kendrick Lamar", "Three 6 Mafia", "Pell",
    ]);
    expect(myRap.references.every((r) => r.enabled)).toBe(true);
    expect(myRap.tier).toBe("free");
  });
  it("five references carry full measurements; the two without audio stay null, not guessed", () => {
    const measured = myRap.references.filter((r) => r.measured !== null);
    expect(measured).toHaveLength(5);
    for (const r of measured) expect(Object.keys(r.measured!)).toHaveLength(7);
    expect(myRap.references.filter((r) => r.measured === null).map((r) => r.id).sort()).toEqual(["pell-the-never", "three-6-mafia-stay-fly"]);
  });
  it("blends the five measured songs; the two unmeasured are reported as awaiting", () => {
    const t = blendTaste(myRap);
    expect(t.confidence).toBe("ok");
    expect(t.used).toHaveLength(5);
    expect(t.awaiting.sort()).toEqual(["pell-the-never", "three-6-mafia-stay-fly"]);
    expect(t.metrics.integrated_lufs).toEqual({ median: -8.56, min: -9.41, max: -4.93, n: 5 });
  });
  it("a blank template has no taste target", () => {
    const t = blendTaste(blankRap);
    expect(t.confidence).toBe("none");
    expect(t.metrics).toEqual({});
    expect(t.awaiting).toHaveLength(7);
  });
  it("flags every BandLab step as unverified", () => {
    for (const s of myRap.steps.filter((s) => s.where === "bandlab")) expect(s.bandlabUnverified).toBe(true);
  });
});

describe("taste blend", () => {
  const measure = (t: typeof myRap, id: string, lufs: number) => setReferenceMeasured(t, id, { integrated_lufs: lufs });
  it("uses only enabled, measured references; reports median/min/max/n", () => {
    let t: typeof myRap = blankRap;
    t = measure(t, "joyner-lucas-lotto", -8);
    t = measure(t, "kendrick-lamar-adhd", -10);
    t = measure(t, "pell-the-never", -12);
    const b = blendTaste(t);
    expect(b.metrics.integrated_lufs).toEqual({ median: -10, min: -12, max: -8, n: 3 });
    expect(b.confidence).toBe("ok");
    expect(b.awaiting.sort()).toEqual(["doja-cat-4-moment", "leather-corduroys-dat-strong", "three-6-mafia-stay-fly", "vinny-paz-design-in-malice"]);
  });
  it("user can switch a reference off and the target changes", () => {
    let t: typeof myRap = blankRap;
    t = measure(t, "joyner-lucas-lotto", -8);
    t = measure(t, "kendrick-lamar-adhd", -10);
    t = setReferenceEnabled(t, "joyner-lucas-lotto", false);
    const b = blendTaste(t);
    expect(b.metrics.integrated_lufs).toEqual({ median: -10, min: -10, max: -10, n: 1 });
    expect(b.confidence).toBe("low");
    expect(b.used).toEqual(["kendrick-lamar-adhd"]);
  });
  it("does not mutate the input template", () => {
    setReferenceEnabled(myRap, "pell-the-never", false);
    expect(myRap.references.find((r) => r.id === "pell-the-never")?.enabled).toBe(true);
  });
  it("a metric nobody measured is absent, not defaulted", () => {
    const b = blendTaste(measure(blankRap, "pell-the-never", -9));
    expect(b.metrics.lra_lu).toBeUndefined();
  });
  it("unknown reference id throws", () => {
    expect(() => setReferenceEnabled(myRap, "nope", true)).toThrow();
  });
});

describe("validateTemplate", () => {
  it("rejects unknown metrics, non-finite values, duplicate ids and non-free tiers", () => {
    const base = JSON.parse(JSON.stringify(myRap));
    const bad = (mut: (t: any) => void) => { const t = JSON.parse(JSON.stringify(base)); mut(t); return () => validateTemplate(t); };
    expect(bad((t) => (t.references[0].measured = { nope: 1 }))).toThrow(/unknown metric/);
    expect(bad((t) => (t.references[0].measured = { integrated_lufs: null }))).toThrow(/finite/);
    expect(bad((t) => (t.references[1].id = t.references[0].id))).toThrow(/duplicate/);
    expect(bad((t) => (t.tier = "paid"))).toThrow(/free/);
    expect(bad((t) => (t.steps[0].where = "x"))).toThrow(/where/);
  });
});
