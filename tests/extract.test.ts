import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT } from "../lib/decision/default";
import { measureAll, type MeasureReport } from "../lib/dsp/measure";
import { extractMetrics } from "../lib/reference/extract";
import { generateSyntheticVocal } from "../lib/dsp/defects/syntheticVocal";
import { DEFECTS } from "../lib/dsp/defects/injectors";
import { noise, sine, SR } from "./helpers";

const defs = DEFAULT_CONTEXT.metrics;
const ok = <T,>(value: T) => ({ ok: true as const, value, elapsedMs: 0 });
const q = <U extends string>(value: number, unit: U) => ({ value, unit });

describe("metric extraction from a Phase 1 report: SYNTHETIC REPORT OBJECTS (hand-built, no audio)", () => {
  const bands = [250, 3150, 4000, 5000, 6300, 8000].map((c) => ({ centerHz: c, lowHz: c / 1.12, highHz: c * 1.12, level: q(-30, "dBFS") }));
  const report = {
    loudness: ok({ integrated: q(-18, "LUFS"), lra: q(6, "LU") }),
    truePeak: ok({ truePeak: q(-2, "dBTP") }),
    thirdOctave: ok({ bands, total: q(-20, "dBFS") }),
    crest: ok({ activeCrest: q(11, "dB") }),
    noise: ok({ noiseFloor: q(-62, "dBFS") }),
    clipping: ok({ clippedSamples: q(480, "samples") }),
    plosive: ok({ eventCount: q(6, "events") }),
  } as unknown as MeasureReport;
  const ctx = { durationSec: 60, sampleRate: 48000, channels: 1 };
  const m = extractMetrics(report, ctx, defs);
  const val = (id: string) => (m[id]!.status === "ok" ? (m[id] as { value: number }).value : NaN);

  it("reads plain fields with their units checked", () => {
    expect(val("integrated_lufs")).toBe(-18);
    expect(val("lra_lu")).toBe(6);
    expect(val("true_peak_dbtp")).toBe(-2);
    expect(val("crest_active_db")).toBe(11);
    expect(val("noise_floor_dbfs")).toBe(-62);
  });

  it("band metrics are power sums minus the total level", () => {
    expect(val("boxiness_250hz_rel_db")).toBeCloseTo(-30 - -20, 9);
    expect(val("presence_3k5_rel_db")).toBeCloseTo(10 * Math.log10(2) - 30 + 20, 9); // two equal bands: +3.01 dB
    expect(val("sibilance_5k9k_rel_db")).toBeCloseTo(10 * Math.log10(3) - 30 + 20, 9);
  });

  it("ratio and per-minute metrics use the file length", () => {
    expect(val("clipped_sample_ratio")).toBeCloseTo(480 / (60 * 48000), 12);
    expect(val("plosive_events_per_min")).toBeCloseTo(6, 9); // 6 events in 60 s
  });

  it("a unit mismatch or a failed measurement becomes 'unavailable' with a reason, never a number", () => {
    const wrongUnit = { ...report, loudness: ok({ integrated: q(-18, "LU"), lra: q(6, "LU") }) } as unknown as MeasureReport;
    const a = extractMetrics(wrongUnit, ctx, defs);
    expect(a["integrated_lufs"]).toMatchObject({ status: "unavailable" });
    const failed = { ...report, noise: { ok: false, error: { code: "NO_NOISE_PRINT", message: "A 2-3 s noise print is required" }, elapsedMs: 0 } } as unknown as MeasureReport;
    const b = extractMetrics(failed, ctx, defs);
    expect(b["noise_floor_dbfs"]).toMatchObject({ status: "unavailable" });
    expect((b["noise_floor_dbfs"] as { reason: string }).reason).toMatch(/noise print is required/);
    const missingBand = { ...report, thirdOctave: ok({ bands: bands.filter((x) => x.centerHz !== 8000), total: q(-20, "dBFS") }) } as unknown as MeasureReport;
    expect(extractMetrics(missingBand, ctx, defs)["sibilance_5k9k_rel_db"]).toMatchObject({ status: "unavailable" });
  });
});

describe("end to end through the real Phase 1 functions: SYNTHETIC AUDIO (generated tones/noise/vocal; no real recordings)", () => {
  const ctxFor = (x: Float32Array) => ({ durationSec: x.length / SR, sampleRate: SR, channels: 1 });
  const metricsFor = (x: Float32Array, print: Float32Array | null = null) =>
    extractMetrics(measureAll({ sampleRate: SR, channels: [x] }, print ? { sampleRate: SR, channels: [print] } : null), ctxFor(x), defs);
  const v = (m: ReturnType<typeof metricsFor>, id: string) => {
    const r = m[id]!;
    if (r.status !== "ok") throw new Error(`${id} unavailable: ${r.reason}`);
    return r.value;
  };

  it("a 250 Hz tone is all 'boxiness' band and no presence; a 4 kHz tone is the reverse", () => {
    const low = metricsFor(sine(250, 0.3, 5));
    expect(v(low, "boxiness_250hz_rel_db")).toBeGreaterThan(-3);
    expect(v(low, "presence_3k5_rel_db")).toBeLessThan(-30);
    const hi = metricsFor(sine(4000, 0.3, 5));
    expect(v(hi, "presence_3k5_rel_db")).toBeGreaterThan(-3);
    expect(v(hi, "boxiness_250hz_rel_db")).toBeLessThan(-30);
  });

  it("clipping shows up as a clipped-sample ratio; clean audio is exactly 0", () => {
    const clean = metricsFor(sine(220, 0.4, 5));
    expect(v(clean, "clipped_sample_ratio")).toBe(0);
    const clipped = sine(220, 1.5, 5).map((s) => Math.max(-0.95, Math.min(0.95, s)));
    expect(v(metricsFor(clipped), "clipped_sample_ratio")).toBeGreaterThan(0.01);
  });

  it("noise floor needs a print: without one it is unavailable, with one it is measured", () => {
    const take = generateSyntheticVocal({ seed: 1, f0Base: 130 }).channels[0]!;
    expect(metricsFor(take)["noise_floor_dbfs"]).toMatchObject({ status: "unavailable" });
    const print = take.slice(0, Math.round(2.5 * SR));
    expect(v(metricsFor(take, print), "noise_floor_dbfs")).toBeCloseTo(-60, 0);
    void noise;
  });

  it("pops in a generated vocal raise plosive events per minute", () => {
    const base = generateSyntheticVocal({ seed: 1, f0Base: 130 });
    const popped = DEFECTS.find((d) => d.id === "plosives")!.inject(base, "moderate", 1).channels[0]!;
    expect(v(metricsFor(base.channels[0]!), "plosive_events_per_min")).toBe(0);
    expect(v(metricsFor(popped), "plosive_events_per_min")).toBeGreaterThan(10);
  });

  it("loudness, LRA, true peak and crest all extract on a generated vocal", () => {
    const m = metricsFor(generateSyntheticVocal({ seed: 2, f0Base: 165 }).channels[0]!);
    for (const id of ["integrated_lufs", "lra_lu", "true_peak_dbtp", "crest_active_db"]) expect(Number.isFinite(v(m, id)), id).toBe(true);
  });
});
