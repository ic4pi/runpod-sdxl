import { describe, expect, it } from "vitest";
import { applyDeess } from "../lib/dsp/chain/deess";
import { CHAIN_ORDER } from "../lib/dsp/config";
import { applyBiquad, highpass, lowpass } from "../lib/dsp/measure/biquad";
import { cfgCopy, dbOf, noise, rmsOf, SR, sine, toneAmp } from "./helpers";

const P = cfgCopy().stages.deess.params;

/** 5-9 kHz band-limited "sibilant" noise burst. */
function sibilance(rms: number, sec: number, seed: number): Float32Array {
  const n = noise(1, sec, seed);
  const bp = applyBiquad(applyBiquad(n, highpass(P.bandLowHz, P.filterQ, SR)), lowpass(P.bandHighHz, P.filterQ, SR));
  const cur = rmsOf(bp);
  return Float32Array.from(bp, (v) => (v * rms) / cur);
}

describe("de-esser", () => {
  it("is applied before compression in the fixed chain order", () => {
    expect(CHAIN_ORDER.indexOf("deess")).toBeGreaterThan(-1);
    expect(CHAIN_ORDER.indexOf("deess")).toBeLessThan(CHAIN_ORDER.indexOf("compressor"));
  });

  it("leaves a signal below the threshold bit-identical", () => {
    const quiet = sibilance(0.001, 1, 3);
    const x = Float32Array.from(sine(300, 0.2, 1), (v, i) => v + quiet[i]!);
    const r = applyDeess(x, SR, P);
    expect(r.maxReductionDb).toBe(0);
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (r.out[i] !== x[i]) diff++;
    expect(diff).toBe(0);
  });

  it("reduces a loud 5-9 kHz burst but not the low-frequency voice under it", () => {
    const sec = 1;
    const vowel = sine(300, 0.2, sec);
    const burstStart = Math.round(0.4 * SR);
    const burstLen = Math.round(0.3 * SR);
    const s = sibilance(0.1, 0.3, 4); // -20 dBFS RMS in-band, well over the -32 dBFS peak threshold
    const x = Float32Array.from(vowel);
    for (let i = 0; i < burstLen; i++) x[burstStart + i] = x[burstStart + i]! + s[i]!;

    const r = applyDeess(x, SR, P);
    const band = (sig: Float32Array) =>
      applyBiquad(applyBiquad(sig, highpass(P.bandLowHz, P.filterQ, SR)), lowpass(P.bandHighHz, P.filterQ, SR));
    const a = burstStart + Math.round(0.05 * SR); // skip attack
    const b = burstStart + burstLen;
    const before = rmsOf(band(x), a, b);
    const after = rmsOf(band(r.out), a, b);
    const reduction = dbOf(before / after);
    expect(reduction).toBeGreaterThan(4); // a high shelf, so less than the full 10 dB at the band edges
    expect(reduction).toBeLessThanOrEqual(-P.maxReductionDb + 0.5);
    expect(r.maxReductionDb).toBeLessThanOrEqual(-P.maxReductionDb + 1e-6);

    // voice at 300 Hz untouched (within 0.2 dB) inside and outside the burst
    for (const [lo, hi] of [[a, b], [0, burstStart - 1000]] as const) {
      const ratio = toneAmp(r.out, 300, lo, hi) / toneAmp(x, 300, lo, hi);
      expect(Math.abs(dbOf(ratio))).toBeLessThan(0.2);
    }
  });

  it("never amplifies and releases back to unity after the burst", () => {
    const x = new Float32Array(SR);
    x.set(sibilance(0.1, 0.2, 6), Math.round(0.2 * SR));
    const r = applyDeess(x, SR, P);
    const floor = Math.pow(10, P.maxReductionDb / 20) - 1e-6; // gain is stored as float32
    let bad = 0;
    for (const g of r.gain) if (g > 1 || g < floor) bad++;
    expect(bad).toBe(0);
    expect(r.gain[SR - 1]).toBeCloseTo(1, 3);
  });
});
