import { describe, expect, it } from "vitest";
import { applyExpander, expanderGainDb } from "../lib/dsp/chain/expander";
import { runJsStage } from "../lib/dsp/chain/jsStages";
import { cfgCopy, noise, SR, sine } from "./helpers";

const cfg = cfgCopy();
const P = cfg.stages.expander.params;
const THR = P.absoluteThresholdDbfs; // -50 dBFS
const FLOOR = Math.pow(10, P.rangeDb / 20);

describe("soft expander (gate)", () => {
  it("static curve: unity above the knee, soft transition, floored at rangeDb", () => {
    expect(expanderGainDb(P.kneeDb, P.ratio, P.kneeDb, P.rangeDb)).toBe(0);
    expect(expanderGainDb(0, P.ratio, P.kneeDb, P.rangeDb)).toBeLessThan(0);
    expect(expanderGainDb(0, P.ratio, P.kneeDb, P.rangeDb)).toBeGreaterThan(-1.01); // soft: about -1 dB at the threshold
    expect(expanderGainDb(-200, P.ratio, P.kneeDb, P.rangeDb)).toBe(P.rangeDb);
    // continuous at the lower knee edge
    const e = 1e-6;
    const a = expanderGainDb(-P.kneeDb / 2 + e, P.ratio, P.kneeDb, P.rangeDb);
    const b = expanderGainDb(-P.kneeDb / 2 - e, P.ratio, P.kneeDb, P.rangeDb);
    expect(Math.abs(a - b)).toBeLessThan(1e-4);
  });

  it("no sample below the threshold is hard-zeroed (sine and noise segments far below threshold)", () => {
    for (const x of [sine(400, 0.0014 * Math.SQRT2, 3), noise(0.0003, 3, 5)]) {
      const r = applyExpander(x, SR, P, THR);
      let checked = 0;
      let zeroed = 0;
      let outOfRange = 0;
      for (let i = 0; i < x.length; i++) {
        if (Math.abs(x[i]!) < 1e-7) continue; // exact zero crossings carry no information
        checked++;
        if (r.out[i] === 0) zeroed++;
        const g = r.out[i]! / x[i]!;
        if (g < FLOOR * 0.999999 || g > 1.000001) outOfRange++;
      }
      expect(checked).toBeGreaterThan(x.length * 0.9);
      expect(zeroed).toBe(0);
      expect(outOfRange).toBe(0);
      expect(r.floorGain).toBeCloseTo(FLOOR, 10);
    }
  });

  it("word tail: a vocal decaying through the threshold is attenuated smoothly, never hard-zeroed on the way down", () => {
    const sec = 3;
    const tau = 0.25;
    const x = new Float32Array(Math.round(sec * SR));
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.exp(-i / (tau * SR)) * Math.sin((2 * Math.PI * 300 * i) / SR);
    // crosses the -50 dBFS threshold (amplitude ~0.0032) at ~1.14 s and keeps falling to ~-95 dBFS
    const r = applyExpander(x, SR, P, THR);

    let prev = 1;
    let maxStep = 0;
    let crossing = -1;
    let belowFloor = 0;
    let aboveUnity = 0;
    let reopened = 0;
    let hardZeroed = 0;
    let tooQuiet = 0;
    for (let i = 0; i < x.length; i++) {
      const g = r.gain[i]!;
      if (g < FLOOR * 0.999999) belowFloor++; // never below the floor
      if (g > 1) aboveUnity++;
      if (g > prev + 1e-7) reopened++; // monotone: closes, never flutters back open on the decay
      maxStep = Math.max(maxStep, prev - g);
      prev = g;
      if (Math.abs(x[i]!) >= 1e-8) {
        if (r.out[i] === 0) hardZeroed++; // no hard-zeroing at any point on the way down
        if (Math.abs(r.out[i]!) < Math.abs(x[i]!) * FLOOR * 0.999999) tooQuiet++;
      }
      if (crossing < 0 && Math.abs(x[i]!) < Math.pow(10, THR / 20) && i > 0.5 * SR) crossing = i;
    }
    expect({ belowFloor, aboveUnity, reopened, hardZeroed, tooQuiet }).toEqual({ belowFloor: 0, aboveUnity: 0, reopened: 0, hardZeroed: 0, tooQuiet: 0 });
    expect(crossing).toBeGreaterThan(0);
    // smooth: no per-sample step anywhere near a gate "chop"
    expect(maxStep).toBeLessThan(1e-3);
    // hold: gain is still ~unity right after the level crosses the threshold (tail not chopped)
    const holdSamples = Math.round((P.holdMs / 1000) * SR);
    expect(r.gain[crossing + Math.floor(holdSamples / 4)]!).toBeGreaterThan(0.95);
    // ...and it does eventually settle at the floor, not at zero
    expect(r.gain[x.length - 1]!).toBeCloseTo(FLOOR, 2);
    // the tail is still audible: at 2 s the output is at most 12 dB below the input
    const a = Math.round(2 * SR);
    let inPk = 0;
    let outPk = 0;
    for (let i = a; i < a + 2000; i++) {
      inPk = Math.max(inPk, Math.abs(x[i]!));
      outPk = Math.max(outPk, Math.abs(r.out[i]!));
    }
    expect(outPk / inPk).toBeGreaterThanOrEqual(FLOOR * 0.999);
  });

  it("holds open for holdMs after a loud-to-quiet step", () => {
    const x = new Float32Array(2 * SR);
    x.set(sine(300, 0.3, 1), 0);
    x.set(sine(300, 0.0005, 1), SR);
    const r = applyExpander(x, SR, P, THR);
    const holdSamples = Math.round((P.holdMs / 1000) * SR);
    // detector lag (RMS window) means the drop is seen slightly after the step; hold keeps gain at 1 for most of holdMs
    expect(r.gain[SR + Math.floor(holdSamples * 0.5)]!).toBeGreaterThan(0.999);
    expect(r.gain[SR + SR / 2]!).toBeLessThan(0.6);
    expect(r.gain[2 * SR - 1]!).toBeLessThan(FLOOR * 1.25); // exponential approach to the floor, not a cliff
  });

  it("stage runner derives the threshold from the noise print and reports it", () => {
    const c = cfgCopy();
    const x = sine(300, 0.2, 1);
    const withPrint = runJsStage("expander", x, { cfg: c, sampleRate: SR, noiseFloorDbfs: -60, confirmed: null, rnnoise: null });
    expect(withPrint.report.metrics?.thresholdDbfs).toBeCloseTo(-60 + P.thresholdOverNoiseDb, 6);
    const noPrint = runJsStage("expander", x, { cfg: c, sampleRate: SR, noiseFloorDbfs: null, confirmed: null, rnnoise: null });
    expect(noPrint.report.metrics?.thresholdDbfs).toBe(P.absoluteThresholdDbfs);
    expect(noPrint.report.note).toMatch(/fallback/);
  });
});
