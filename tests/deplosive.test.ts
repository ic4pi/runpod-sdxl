import { describe, expect, it } from "vitest";
import { runClippingCheck } from "../lib/dsp/chain/clippingCheck";
import { applyDeplosive, detectPlosives } from "../lib/dsp/chain/deplosive";
import { runJsStage } from "../lib/dsp/chain/jsStages";
import { confirmPlosives, type PlosiveCandidate } from "../lib/dsp/chain/types";
import { DEFECTS } from "../lib/dsp/defects/injectors";
import { generateSyntheticVocal } from "../lib/dsp/defects/syntheticVocal";
import { findOnsets } from "../lib/dsp/defects/util";
import { cfgCopy, clipAsym, dbOf, SR, sine, toneAmp } from "./helpers";

const cfg = cfgCopy();
const D = cfg.stages.deplosive.params;
const plosiveInjector = DEFECTS.find((d) => d.id === "plosives")!;
const clipInjector = DEFECTS.find((d) => d.id === "clipping")!;

/** The way the pipeline runs it: clipping-check decides `clipped`, detection is told. */
function detect(x: Float32Array, detectParams = D.detect) {
  const c = runClippingCheck(x, SR, cfg.stages.clippingCheck.params);
  return { clipped: c.clipped, events: detectPlosives(x, SR, detectParams, c.clipped) };
}

const F0S = [85, 95, 130, 165, 200, 260];
const SEEDS = [9, 10, 11];

/** Three ways a phone clips a plosive-free vocal: symmetric, one-sided, and an extreme rectifier-like case. */
const CLIP_STYLES: [string, (x: Float32Array) => Float32Array][] = [
  ["symmetric +14 dB", (x) => clipAsym(x, 0.5, 0.5, 14)],
  ["one-sided (+0.05 / -1.0) +20 dB", (x) => clipAsym(x, 0.05, 1, 20)],
  ["extreme asymmetric (+0.02 / -0.9) +30 dB", (x) => clipAsym(x, 0.02, 0.9, 30)],
];

describe("de-plosive detection", () => {
  it("proposes nothing on clean, plosive-free vocals", () => {
    for (const f0 of F0S) {
      const v = generateSyntheticVocal({ seed: 5, f0Base: f0 }).channels[0]!;
      const r = detect(v);
      expect(r.clipped).toBe(false);
      expect(r.events, `F0 ${f0}`).toHaveLength(0);
    }
  });

  it("finds injected pops on a clean vocal (>= 5 of 6 within 60 ms)", () => {
    const base = generateSyntheticVocal({ seed: 5, f0Base: 130 });
    const injectedAt = findOnsets(base, 3).slice(0, 6).map((t) => t - 0.015);
    for (const sev of ["mild", "moderate", "severe"] as const) {
      const v = plosiveInjector.inject(base, sev, 5).channels[0]!;
      const { events } = detect(v);
      const matched = injectedAt.filter((t) => events.some((e) => Math.abs(e.startSec - t) <= 0.06)).length;
      expect(matched, sev).toBeGreaterThanOrEqual(5);
      expect(events.length, sev).toBeLessThanOrEqual(injectedAt.length + 2);
    }
  });

  describe("CLIPPED but plosive-free input must not fire spuriously", () => {
    const inputs: { name: string; x: Float32Array }[] = [];
    for (const f0 of F0S) for (const seed of SEEDS) {
      const v = generateSyntheticVocal({ seed, f0Base: f0 }).channels[0]!;
      for (const [style, clip] of CLIP_STYLES) inputs.push({ name: `F0 ${f0}, seed ${seed}, ${style}`, x: clip(v) });
    }

    it(`proposes 0 pops on all ${inputs.length} clipped plosive-free files (and clipping-check flags every one as clipped)`, () => {
      const failures: string[] = [];
      for (const { name, x } of inputs) {
        const r = detect(x);
        if (!r.clipped) failures.push(`${name}: not flagged as clipped (test input invalid)`);
        if (r.events.length > 0) failures.push(`${name}: ${r.events.length} spurious event(s)`);
      }
      expect(failures).toEqual([]);
    });

    it("is not vacuous: with the clipped-file margin disabled, the same inputs DO produce spurious events", () => {
      const noMargin = { ...D.detect, clippedExtraRiseDb: 0 };
      const spurious = inputs.reduce((n, { x }) => n + detect(x, noMargin).events.length, 0);
      expect(spurious).toBeGreaterThanOrEqual(20);
    });

    it("still detects most real pops on clipped audio (recall >= 70%; the margin has a cost)", () => {
      let found = 0;
      let injected = 0;
      for (const f0 of [95, 130, 200]) {
        const base = generateSyntheticVocal({ seed: 9, f0Base: f0 });
        const at = findOnsets(base, 3).slice(0, 6).map((t) => t - 0.015);
        for (const sev of ["mild", "moderate"] as const) {
          const v = clipInjector.inject(plosiveInjector.inject(base, sev, 1), "moderate", 1).channels[0]!;
          const { clipped, events } = detect(v);
          expect(clipped).toBe(true);
          found += at.filter((t) => events.some((e) => Math.abs(e.startSec - t) <= 0.06)).length;
          injected += at.length;
        }
      }
      expect(found / injected).toBeGreaterThanOrEqual(0.7);
    });
  });
});

describe("de-plosive apply", () => {
  const ev = (startSec: number, durationMs: number): PlosiveCandidate => ({
    id: 0, startSec, durationMs, lfPeakDbfs: -20, lfFractionDb: 0, onsetRiseDb: 40, overMedianDb: 30,
  });

  it("dips the low end only inside confirmed events, leaves highs alone, and is bit-exact elsewhere", () => {
    const x = Float32Array.from(sine(100, 0.2, 2), (v, i) => v + 0.2 * Math.sin((2 * Math.PI * 2000 * i) / SR));
    const confirmed = confirmPlosives([ev(1.0, 40)], [0]);
    const r = applyDeplosive(x, SR, confirmed, D.apply);
    const a = Math.round(1.0 * SR) + 400;
    const b = Math.round(1.04 * SR);
    expect(dbOf(toneAmp(r.out, 100, a, b) / toneAmp(x, 100, a, b))).toBeLessThan(-6);
    expect(Math.abs(dbOf(toneAmp(r.out, 2000, a, b) / toneAmp(x, 2000, a, b)))).toBeLessThan(0.3);
    const untouchedUntil = Math.round((1.0 - D.apply.padBeforeMs / 1000) * SR) - 1;
    const untouchedFrom = Math.round((1.04 + (D.apply.padAfterMs + 5) / 1000) * SR);
    let diff = 0;
    for (let i = 0; i < untouchedUntil; i++) if (r.out[i] !== x[i]) diff++;
    for (let i = untouchedFrom; i < x.length; i++) if (r.out[i] !== x[i]) diff++;
    expect(diff).toBe(0);
    expect(r.appliedEvents).toBe(1);
  });

  it("NEVER fires silently: without confirmation the stage passes audio through and reports awaiting-confirmation", () => {
    const x = sine(100, 0.2, 1);
    const r = runJsStage("deplosive", x, { cfg, sampleRate: SR, noiseFloorDbfs: null, confirmed: null, rnnoise: null });
    expect(r.report.status).toBe("awaiting-confirmation");
    expect(r.out).toBe(x); // same array, untouched
  });

  it("confirming zero events changes nothing and says so", () => {
    const x = sine(100, 0.2, 1);
    const none = confirmPlosives([ev(0.5, 30)], []);
    const r = runJsStage("deplosive", x, { cfg, sampleRate: SR, noiseFloorDbfs: null, confirmed: none, rnnoise: null });
    expect(r.report.status).toBe("skipped");
    expect(Array.from(r.out)).toEqual(Array.from(x));
  });

  it("confirmPlosives keeps only the selected ids", () => {
    const list = [ev(1, 30), { ...ev(2, 30), id: 1 }, { ...ev(3, 30), id: 2 }];
    expect(confirmPlosives(list, [0, 2]).events.map((e) => e.id)).toEqual([0, 2]);
  });
});
