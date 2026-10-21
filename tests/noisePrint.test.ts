import { beforeAll, describe, expect, it } from "vitest";
import { validateNoisePrint } from "../lib/dsp/chain/noisePrint";
import type { RnnoiseEngine } from "../lib/dsp/chain/rnnoise";
import { generateSyntheticVocal } from "../lib/dsp/defects/syntheticVocal";
import { cfgCopy, loadEngine, noise, SR, sine } from "./helpers";

const P = cfgCopy().stages.noisePrint.params;
let engine: RnnoiseEngine;
beforeAll(async () => {
  engine = await loadEngine();
});
const check = (x: Float32Array, vad: boolean | "unavailable" = true) =>
  validateNoisePrint(x, SR, P, vad === true ? engine.process(x).vad : null);
const layers = (v: ReturnType<typeof check>) => v.rejections.map((r) => r.layer);

/** Sustained steady vowel: no pauses, no level change; only VAD / periodicity can catch it. */
function sustainedVowel(f0: number, sec: number, amp: number): Float32Array {
  const x = new Float32Array(Math.round(sec * SR));
  const formants: [number, number, number][] = [[730, 90, 1], [1090, 130, 0.7], [2440, 180, 0.4]];
  for (let h = 1; h * f0 < 5000; h++) {
    const f = h * f0;
    const g = formants.reduce((s, [c, bw, a]) => s + a / (1 + ((f - c) / bw) ** 2), 0) / h;
    for (let i = 0; i < x.length; i++) x[i] = x[i]! + amp * g * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return x;
}

describe("noise-print validation: what is accepted", () => {
  it("accepts plain room noise (-60 dBFS) and reports its floor", () => {
    const v = check(noise(0.001, 2.5, 1));
    expect(v.rejections).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.noiseFloorDbfs).toBeCloseTo(-60, 0);
  });

  it("accepts the room-tone head of a generated vocal take", () => {
    const take = generateSyntheticVocal({ seed: 1, f0Base: 130 });
    const v = check(take.channels[0]!.slice(0, Math.round(2.5 * SR)));
    expect(v.rejections).toEqual([]);
  });

  it("accepts mains hum (60 Hz + harmonics): hum is noise worth printing, not a voice", () => {
    const x = noise(0.0005, 2.5, 2);
    for (const [h, a] of [[1, 0.01], [2, 0.005], [3, 0.003], [4, 0.002]] as const) {
      const t = sine(60 * h, a, 2.5);
      for (let i = 0; i < x.length; i++) x[i] = x[i]! + t[i]!;
    }
    const v = check(x);
    expect(v.rejections).toEqual([]);
  });
});

describe("noise-print validation: what is rejected (and by which layer)", () => {
  it("REJECTS a print that contains speech (syllables with pauses) - energy layer", () => {
    const take = generateSyntheticVocal({ seed: 1, f0Base: 130 });
    const speech = take.channels[0]!.slice(Math.round(3 * SR), Math.round(5.5 * SR)); // 2.5 s of speech
    const v = check(speech);
    expect(v.ok).toBe(false);
    expect(layers(v)).toContain("energy");
    expect(v.metrics.blockSpreadDb).toBeGreaterThan(P.maxBlockSpreadDb);
  });

  it("REJECTS speech even when there are no pauses and no level change (sustained vowel) - VAD and/or periodicity layer", () => {
    const vowel = sustainedVowel(130, 2.5, 0.05);
    const tone = noise(0.0005, 2.5, 9);
    const x = Float32Array.from(vowel, (v, i) => v + tone[i]!);
    const v = check(x);
    expect(v.ok).toBe(false);
    // energy and bump layers see nothing wrong here; the voice-specific layers must catch it
    expect(layers(v)).not.toContain("energy");
    expect(layers(v).some((l) => l === "vad" || l === "harmonic")).toBe(true);
    expect(v.metrics.voicedFraction).toBeGreaterThan(P.harmonic.maxVoicedFraction);
  });

  it("REJECTS a sustained vowel using the periodicity layer alone (VAD unavailable still fails closed on VAD)", () => {
    const x = sustainedVowel(130, 2.5, 0.05);
    const v = check(x, "unavailable");
    expect(layers(v)).toContain("harmonic");
    expect(layers(v)).toContain("vad"); // fail-closed: no VAD values => cannot verify speech-free
  });

  it("REJECTS a knock/bump (single loud 50 ms event) - bump layer", () => {
    const x = noise(0.001, 2.5, 3);
    const hit = sine(200, 0.2, 0.05);
    for (let i = 0; i < hit.length; i++) x[SR + i] = x[SR + i]! + hit[i]! * Math.exp(-i / (0.01 * SR));
    const v = check(x);
    expect(v.ok).toBe(false);
    expect(layers(v)).toContain("bump");
  });

  it("REJECTS wrong lengths and digital silence", () => {
    expect(layers(check(noise(0.001, 1, 4)))).toEqual(["length"]);
    expect(layers(check(noise(0.001, 8, 4)))).toEqual(["length"]);
    expect(layers(check(new Float32Array(Math.round(2.5 * SR))))).toEqual(["silence"]);
  });

  it("every rejection carries a human-readable message and the measured value vs limit", () => {
    const v = check(sustainedVowel(130, 2.5, 0.05));
    for (const r of v.rejections) {
      expect(r.message.length).toBeGreaterThan(10);
      expect(r).toHaveProperty("limit");
    }
  });
});
