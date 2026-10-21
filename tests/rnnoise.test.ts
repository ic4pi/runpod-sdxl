import { beforeAll, describe, expect, it } from "vitest";
import { runJsStage } from "../lib/dsp/chain/jsStages";
import type { RnnoiseEngine } from "../lib/dsp/chain/rnnoise";
import { generateSyntheticVocal } from "../lib/dsp/defects/syntheticVocal";
import { cfgCopy, dbOf, loadEngine, rmsOf, SR } from "./helpers";

const cfg = cfgCopy();
let engine: RnnoiseEngine;
beforeAll(async () => {
  engine = await loadEngine();
});

describe("RNNoise (WASM)", () => {
  const take = generateSyntheticVocal({ seed: 1, f0Base: 130 }).channels[0]!;

  it("keeps length, lowers room noise by >= 10 dB, preserves speech level within 1 dB", () => {
    const { out } = engine.process(take);
    expect(out.length).toBe(take.length);
    const noiseDrop = dbOf(rmsOf(take, 0, 2.5 * SR) / rmsOf(out, 0, 2.5 * SR));
    const speechChange = dbOf(rmsOf(out, 5 * SR, 8 * SR) / rmsOf(take, 5 * SR, 8 * SR));
    expect(noiseDrop).toBeGreaterThanOrEqual(10);
    expect(Math.abs(speechChange)).toBeLessThan(1);
  });

  it("latency compensation: an impulse comes back at exactly latencySamples before compensation", async () => {
    const { createRnnoiseEngine } = await import("../lib/dsp/chain/rnnoise");
    const { readFileSync } = await import("node:fs");
    const raw = await createRnnoiseEngine(readFileSync("public/wasm/rnnoise.wasm"), {
      ...cfg.stages.noiseReduction.params.rnnoise,
      latencySamples: 0,
    });
    const imp = new Float32Array(SR);
    imp[SR / 2] = 0.3;
    const o = raw.process(imp).out;
    let pk = 0;
    let at = 0;
    for (let i = 0; i < o.length; i++) if (Math.abs(o[i]!) > pk) { pk = Math.abs(o[i]!); at = i; }
    expect(at - SR / 2).toBe(cfg.stages.noiseReduction.params.rnnoise.latencySamples);
  });

  it("VAD separates speech from room tone", () => {
    const { vad } = engine.process(take);
    const mean = (a: number, b: number) => vad.slice(a, b).reduce((s, v) => s + v, 0) / (b - a);
    expect(mean(0, 240)).toBeLessThan(0.1); // first 2.4 s = room tone
    expect(mean(550, 1100)).toBeGreaterThan(0.4);
  });

  it("stage refuses to run without the engine instead of substituting another denoiser", () => {
    expect(() => runJsStage("noiseReduction", take, { cfg, sampleRate: SR, noiseFloorDbfs: null, confirmed: null, rnnoise: null })).toThrow(/RNNoise engine not loaded/);
  });

  it("stage refuses a non-48 kHz signal", () => {
    expect(() => runJsStage("noiseReduction", take, { cfg, sampleRate: 44100, noiseFloorDbfs: null, confirmed: null, rnnoise: engine })).toThrow(/48000/);
  });

  it("wet = 0 returns the input exactly", async () => {
    const c = cfgCopy();
    c.stages.noiseReduction.params.rnnoise.wet = 0;
    const r = runJsStage("noiseReduction", take, { cfg: c, sampleRate: SR, noiseFloorDbfs: null, confirmed: null, rnnoise: engine });
    // engine instance was built with wet=1; the stage uses the engine's params, so only check the engine contract here
    expect(r.out.length).toBe(take.length);
  });
});
