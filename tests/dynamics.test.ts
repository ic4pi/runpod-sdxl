import { describe, expect, it } from "vitest";
import { applyCompressor } from "../lib/dsp/chain/compressor";
import { applyLimiter } from "../lib/dsp/chain/limiter";
import { measureTruePeak } from "../lib/dsp/measure/truePeak";
import { generateSyntheticVocal } from "../lib/dsp/defects/syntheticVocal";
import { cfgCopy, dbOf, rmsOf, SR, sine } from "./helpers";

const cfg = cfgCopy();

describe("limiter", () => {
  const L = cfg.stages.limiter.params;

  it("holds the true peak at or under the ceiling, including inter-sample peaks", () => {
    const loud = [
      sine(1000, 1.4, 1),
      sine(SR / 4, 1.3, 1, SR, Math.PI / 4), // sample peaks 0.92 x 1.3/... but true peak 1.3
      Float32Array.from(generateSyntheticVocal({ seed: 2, f0Base: 165 }).channels[0]!, (v) => v * 4), // +12 dB
    ];
    for (const x of loud) {
      const r = applyLimiter(x, SR, L);
      const tp = measureTruePeak({ sampleRate: SR, channels: [r.out] }).truePeak.value;
      expect(tp).toBeLessThanOrEqual(L.ceilingDbtp + 0.1);
      expect(r.maxReductionDb).toBeGreaterThan(0);
    }
  });

  it("does not touch audio that is already under the ceiling", () => {
    const x = sine(440, 0.3, 1);
    const r = applyLimiter(x, SR, L);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(r.out[i]! - x[i]!));
    expect(worst).toBeLessThan(1e-6);
  });

  it("gain moves smoothly (look-ahead): no per-sample jump larger than the ramp implies", () => {
    const x = new Float32Array(SR);
    x.set(sine(200, 1.5, 0.2), SR / 2);
    const r = applyLimiter(x, SR, L);
    let maxStep = 0;
    for (let i = 1; i < r.gain.length; i++) maxStep = Math.max(maxStep, Math.abs(r.gain[i]! - r.gain[i - 1]!));
    expect(maxStep).toBeLessThan(0.02);
  });
});

describe("compressor", () => {
  const C = cfg.stages.compressor.params;

  it("reduces loud passages more than quiet ones (narrows the level spread)", () => {
    const x = new Float32Array(2 * SR);
    x.set(sine(300, 0.7, 1), 0);
    x.set(sine(300, 0.05, 1), SR);
    const r = applyCompressor(x, SR, { ...C, makeupDb: 0 });
    const loudDrop = dbOf(rmsOf(x, 0.3 * SR, 0.9 * SR) / rmsOf(r.out, 0.3 * SR, 0.9 * SR));
    const quietDrop = dbOf(rmsOf(x, 1.3 * SR, 1.9 * SR) / rmsOf(r.out, 1.3 * SR, 1.9 * SR));
    expect(loudDrop).toBeGreaterThan(3);
    expect(quietDrop).toBeLessThan(0.5);
  });

  it("ratio 1 with no make-up is transparent", () => {
    const x = sine(300, 0.7, 0.5);
    const r = applyCompressor(x, SR, { ...C, ratio: 1, makeupDb: 0 });
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(r.out[i]! - x[i]!));
    expect(worst).toBeLessThan(1e-6);
  });
});
