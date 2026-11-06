import { describe, expect, it } from "vitest";
import { blendTaste, myRap, setReferenceEnabled, setReferenceMeasured, validateTemplate } from "../lib/templates";

describe("my-rap template", () => {
  it("ships the five references, all enabled, none measured (nothing invented)", () => {
    expect(myRap.references.map((r) => r.artist)).toEqual(["Joyner Lucas", "Kendrick Lamar", "Three 6 Mafia", "Pell", "Vinny Paz"]);
    expect(myRap.references.every((r) => r.enabled && r.measured === null)).toBe(true);
    expect(myRap.tier).toBe("free");
  });
  it("has no taste target until something is measured", () => {
    const t = blendTaste(myRap);
    expect(t.confidence).toBe("none");
    expect(t.metrics).toEqual({});
    expect(t.awaiting).toHaveLength(5);
  });
  it("flags every BandLab step as unverified", () => {
    for (const s of myRap.steps.filter((s) => s.where === "bandlab")) expect(s.bandlabUnverified).toBe(true);
  });
});

describe("taste blend", () => {
  const measure = (t: typeof myRap, id: string, lufs: number) => setReferenceMeasured(t, id, { integrated_lufs: lufs });
  it("uses only enabled, measured references; reports median/min/max/n", () => {
    let t = myRap;
    t = measure(t, "joyner-lucas-lotto", -8);
    t = measure(t, "kendrick-lamar-adhd", -10);
    t = measure(t, "pell-the-never", -12);
    const b = blendTaste(t);
    expect(b.metrics.integrated_lufs).toEqual({ median: -10, min: -12, max: -8, n: 3 });
    expect(b.confidence).toBe("ok");
    expect(b.awaiting.sort()).toEqual(["three-6-mafia-stay-fly", "vinny-paz-pick"]);
  });
  it("user can switch a reference off and the target changes", () => {
    let t = myRap;
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
    const b = blendTaste(measure(myRap, "pell-the-never", -9));
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
