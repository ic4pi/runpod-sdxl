import { describe, expect, it } from "vitest";
import { levelMatchGains, levelFromReport } from "../lib/dsp/chain/levelMatch";
import { linearQToDb, makeReverbIr, makeSaturationCurve, spaceTailSec } from "../lib/dsp/chain/native";
import { computePeaks } from "../lib/audio/peaks";
import { encodeWav, parseWav } from "../lib/dsp/fixtures/wav";
import { measureAll } from "../lib/dsp/measure";
import { cfgCopy, SR, sine } from "./helpers";

const cfg = cfgCopy();

describe("native-stage helpers (pure)", () => {
  it("Web Audio uses dB for lowpass/highpass Q; Butterworth Q 0.7071 -> -3.01 dB", () => {
    expect(linearQToDb(Math.SQRT1_2)).toBeCloseTo(-3.0103, 3);
  });

  it("saturation curve: unity slope at 0, odd-symmetric, bounded, softer at the top", () => {
    const c = makeSaturationCurve(cfg.stages.saturation.params.driveDb, cfg.stages.saturation.params.curveSize);
    const n = c.length;
    const mid = (n - 1) / 2;
    const slope = (c[Math.ceil(mid) + 1]! - c[Math.floor(mid) - 1]!) / (2 / (n - 1) * 3);
    expect(slope).toBeGreaterThan(0.99);
    expect(slope).toBeLessThan(1.01);
    for (let i = 0; i < n; i++) expect(c[i]! + c[n - 1 - i]!).toBeCloseTo(0, 6);
    expect(Math.abs(c[n - 1]!)).toBeLessThan(1);
    expect(c[n - 1]!).toBeLessThan(1 * 0.6); // y(1) = tanh(2)/2
  });

  it("reverb IR is deterministic, unit-energy, has pre-delay silence and decays", () => {
    const p = cfg.stages.space.params.reverb;
    const a = makeReverbIr(SR, p);
    const b = makeReverbIr(SR, p);
    expect(Array.from(a.slice(0, 5000))).toEqual(Array.from(b.slice(0, 5000)));
    const pre = Math.round((p.preDelayMs / 1000) * SR);
    expect(a.slice(0, pre).every((v) => v === 0)).toBe(true);
    let e = 0;
    for (const v of a) e += v * v;
    expect(e).toBeCloseTo(1, 4);
    const tenth = Math.floor((a.length - pre) / 10);
    const energy = (from: number) => a.slice(from, from + tenth).reduce((s, v) => s + v * v, 0);
    expect(energy(pre + tenth * 9)).toBeLessThan(energy(pre) * 0.01);
    const other = makeReverbIr(SR, { ...p, irSeed: p.irSeed + 1 });
    expect(Array.from(other.slice(pre, pre + 100))).not.toEqual(Array.from(a.slice(pre, pre + 100)));
  });

  it("render tail covers reverb, is capped by tailPaddingSec, and is zero when space is dry", () => {
    const sp = cfg.stages.space.params;
    expect(spaceTailSec(sp)).toBeGreaterThan(0);
    expect(spaceTailSec(sp)).toBeLessThanOrEqual(sp.tailPaddingSec);
    expect(spaceTailSec({ ...sp, reverb: { ...sp.reverb, mix: 0 } })).toBe(0);
  });
});

describe("level matching", () => {
  it("turns the louder side down, never adds gain", () => {
    expect(levelMatchGains({ value: -20, method: "LUFS" }, { value: -14, method: "LUFS" })).toEqual({ originalGainDb: 0, processedGainDb: -6, method: "LUFS" });
    expect(levelMatchGains({ value: -14, method: "LUFS" }, { value: -20, method: "LUFS" })).toEqual({ originalGainDb: -6, processedGainDb: 0, method: "LUFS" });
  });
  it("refuses to compare LUFS with RMS", () => {
    expect(() => levelMatchGains({ value: -20, method: "LUFS" }, { value: -20, method: "RMS" })).toThrow(/across methods/);
  });
  it("uses LUFS for >= 3 s and falls back to RMS for short audio (explicitly, never silently)", () => {
    const long = levelFromReport(measureAll({ sampleRate: SR, channels: [sine(300, 0.3, 4)] }, null));
    expect(long.method).toBe("LUFS");
    const short = levelFromReport(measureAll({ sampleRate: SR, channels: [sine(300, 0.3, 1)] }, null));
    expect(short.method).toBe("RMS");
  });
});

describe("waveform peaks", () => {
  it("aligns signals of different length on a shared time axis", () => {
    const a = computePeaks(sine(100, 0.5, 1), SR, 100, 2);
    expect(a.max[10]).toBeGreaterThan(0.4);
    expect(a.max[90]).toBe(0); // second half is silent: shorter signal ends at 1 s of a 2 s axis
    expect(computePeaks(sine(100, 0.5, 1), SR, 100, 1, 0.5).max[10]).toBeLessThan(0.3);
  });
});

describe("WAV loader", () => {
  it("round-trips 16-bit PCM and 32-bit float, mono and stereo", () => {
    const x = sine(440, 0.5, 0.2);
    const y = sine(220, 0.25, 0.2);
    for (const bits of [16, 32] as const) {
      const back = parseWav(encodeWav({ sampleRate: 44100, channels: [x, y] }, bits));
      expect(back.sampleRate).toBe(44100);
      expect(back.channels).toHaveLength(2);
      const tol = bits === 16 ? 1 / 32767 : 1e-7;
      let worst = 0;
      for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(back.channels[0]![i]! - x[i]!));
      expect(worst).toBeLessThanOrEqual(tol);
    }
  });
  it("rejects non-WAV and unsupported encodings with explicit errors", () => {
    expect(() => parseWav(new Uint8Array(100))).toThrow(/RIFF/);
    const bytes = encodeWav({ sampleRate: SR, channels: [sine(440, 0.5, 0.1)] });
    new DataView(bytes.buffer).setUint16(20, 2, true); // ADPCM
    expect(() => parseWav(bytes)).toThrow(/Unsupported WAV encoding/);
  });
});
