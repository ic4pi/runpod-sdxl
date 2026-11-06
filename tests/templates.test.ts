import { describe, expect, it } from "vitest";
import { blendTaste, myRap, setReferenceEnabled, setReferenceMeasured, validateTemplate } from "../lib/templates";

// A copy with every measurement cleared, so blend tests control their own inputs.
const blankRap = { ...myRap, references: myRap.references.map((r) => ({ ...r, measured: null })) };

describe("my-rap template", () => {
  it("ships five neutral reference clips, all enabled, with no song or artist names", () => {
    expect(myRap.references.map((r) => r.label)).toEqual(["Reference 1", "Reference 2", "Reference 3", "Reference 4", "Reference 5"]);
    expect(myRap.references.every((r) => r.enabled)).toBe(true);
    expect(JSON.stringify(myRap)).not.toMatch(/artist|track"/);
    expect(myRap.tier).toBe("free");
  });
  it("every reference carries all seven measurements", () => {
    for (const r of myRap.references) expect(Object.keys(r.measured!)).toHaveLength(7);
  });
  it("blends the five clips", () => {
    const t = blendTaste(myRap);
    expect(t.confidence).toBe("ok");
    expect(t.used).toHaveLength(5);
    expect(t.awaiting).toEqual([]);
    expect(t.metrics.integrated_lufs).toEqual({ median: -8.56, min: -9.41, max: -4.93, n: 5 });
  });
  it("a blank template has no taste target", () => {
    const t = blendTaste(blankRap);
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
    let t: typeof myRap = blankRap;
    t = measure(t, "ref-1", -8);
    t = measure(t, "ref-5", -10);
    t = measure(t, "ref-2", -12);
    const b = blendTaste(t);
    expect(b.metrics.integrated_lufs).toEqual({ median: -10, min: -12, max: -8, n: 3 });
    expect(b.confidence).toBe("ok");
    expect(b.awaiting.sort()).toEqual(["ref-3", "ref-4"]);
  });
  it("user can switch a reference off and the target changes", () => {
    let t: typeof myRap = blankRap;
    t = measure(t, "ref-1", -8);
    t = measure(t, "ref-5", -10);
    t = setReferenceEnabled(t, "ref-1", false);
    const b = blendTaste(t);
    expect(b.metrics.integrated_lufs).toEqual({ median: -10, min: -10, max: -10, n: 1 });
    expect(b.confidence).toBe("low");
    expect(b.used).toEqual(["ref-5"]);
  });
  it("does not mutate the input template", () => {
    setReferenceEnabled(myRap, "ref-2", false);
    expect(myRap.references.find((r) => r.id === "ref-2")?.enabled).toBe(true);
  });
  it("a metric nobody measured is absent, not defaulted", () => {
    const b = blendTaste(measure(blankRap, "ref-2", -9));
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
