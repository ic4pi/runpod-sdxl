import { describe, expect, it } from "vitest";
import { measureClipping } from "../lib/dsp/measure/clipping";
import { measureCorrelation } from "../lib/dsp/measure/correlation";
import { measureCrest } from "../lib/dsp/measure/crest";
import { measureDcOffset } from "../lib/dsp/measure/dcOffset";
import { measureAll } from "../lib/dsp/measure";
import { measureLoudness } from "../lib/dsp/measure/loudness";
import { measureNoise } from "../lib/dsp/measure/noise";
import { measureThirdOctave } from "../lib/dsp/measure/thirdOctave";
import { measureTruePeak } from "../lib/dsp/measure/truePeak";
import { MeasurementError, type Pcm } from "../lib/dsp/measure/types";
import { makeRng } from "../lib/dsp/defects/rng";

const SR = 48000;
const sine = (hz: number, amp: number, sec: number, phase = 0, sr = SR): Float32Array => {
  const x = new Float32Array(Math.round(sec * sr));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr + phase);
  return x;
};
const mono = (x: Float32Array, sr = SR): Pcm => ({ sampleRate: sr, channels: [x] });
const noise = (sigma: number, sec: number, seed: number): Float32Array => {
  const r = makeRng(seed);
  const x = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < x.length; i++) {
    // sum of 12 uniforms ~ gaussian
    let s = 0;
    for (let k = 0; k < 12; k++) s += r();
    x[i] = (s - 6) * sigma;
  }
  return x;
};

describe("loudness", () => {
  it("full-scale 1 kHz sine mono reads about -3.0 LUFS (BS.1770 reference)", () => {
    const r = measureLoudness(mono(sine(1000, 1, 10)));
    expect(r.integrated.value).toBeGreaterThan(-3.2);
    expect(r.integrated.value).toBeLessThan(-2.8);
    expect(r.integrated.unit).toBe("LUFS");
  });
  it("-20 dB lower amplitude reads 20 LU lower; steady tone has ~0 LRA", () => {
    const a = measureLoudness(mono(sine(1000, 1, 10)));
    const b = measureLoudness(mono(sine(1000, 0.1, 10)));
    expect(a.integrated.value - b.integrated.value).toBeCloseTo(20, 1);
    expect(b.lra.value).toBeLessThan(0.1);
    expect(b.shortTermMax.value).toBeCloseTo(b.integrated.value, 1);
  });
  it("LRA reflects a 10 dB level step", () => {
    const x = new Float32Array(20 * SR);
    x.set(sine(1000, 0.3, 10), 0);
    x.set(sine(1000, 0.3 * Math.pow(10, -10 / 20), 10), 10 * SR);
    const r = measureLoudness(mono(x));
    expect(r.lra.value).toBeGreaterThan(8);
    expect(r.lra.value).toBeLessThan(11);
  });
  it("works at 44.1 kHz", () => {
    const r = measureLoudness(mono(sine(1000, 1, 10, 0, 44100), 44100));
    expect(r.integrated.value).toBeGreaterThan(-3.2);
    expect(r.integrated.value).toBeLessThan(-2.8);
  });
  it("throws on silence and on <3 s audio", () => {
    expect(() => measureLoudness(mono(new Float32Array(5 * SR)))).toThrow(MeasurementError);
    expect(() => measureLoudness(mono(sine(1000, 1, 2)))).toThrow(/3 s/);
  });
});

describe("true peak", () => {
  it("finds inter-sample peak: fs/4 sine at 45 deg has sample peak -3 dB but true peak ~0 dBTP", () => {
    const r = measureTruePeak(mono(sine(SR / 4, 1, 1, Math.PI / 4)));
    expect(r.samplePeak.value).toBeCloseTo(-3.01, 1);
    expect(r.truePeak.value).toBeGreaterThan(-0.15);
    expect(r.truePeak.value).toBeLessThan(0.15);
    expect(r.truePeak.unit).toBe("dBTP");
  });
  it("throws on silence", () => {
    expect(() => measureTruePeak(mono(new Float32Array(1000)))).toThrow(MeasurementError);
  });
});

describe("third octave", () => {
  it("0.5-amplitude 1 kHz sine lands in the 1 kHz band at -9.0 dBFS", () => {
    const r = measureThirdOctave(mono(sine(1000, 0.5, 4)));
    const band = r.bands.reduce((a, b) => (b.level.value > a.level.value ? b : a));
    expect(Math.round(band.centerHz)).toBe(1000);
    expect(band.level.value).toBeGreaterThan(-9.4);
    expect(band.level.value).toBeLessThan(-8.7);
    expect(r.total.value).toBeCloseTo(-9.03, 1);
  });
  it("throws when shorter than one FFT frame", () => {
    expect(() => measureThirdOctave(mono(sine(1000, 1, 0.1)))).toThrow(MeasurementError);
  });
});

describe("crest, correlation, dc", () => {
  it("sine crest is 3.01 dB", () => {
    expect(measureCrest(mono(sine(500, 0.5, 2))).crest.value).toBeCloseTo(3.01, 1);
  });
  it("correlation: identical +1, inverted -1, mono throws", () => {
    const x = sine(300, 0.5, 1);
    expect(measureCorrelation({ sampleRate: SR, channels: [x, x] }).correlation.value).toBeCloseTo(1, 5);
    expect(measureCorrelation({ sampleRate: SR, channels: [x, x.map((v) => -v)] }).correlation.value).toBeCloseTo(-1, 5);
    expect(() => measureCorrelation(mono(x))).toThrow(/mono/);
  });
  it("dc offset is measured per channel", () => {
    const x = sine(300, 0.5, 1).map((v) => v + 0.02);
    const r = measureDcOffset(mono(x));
    expect(r.maxAbs.value).toBeCloseTo(0.02, 4);
  });
});

describe("clipping", () => {
  it("clean sine has no runs; hard-clipped sine has runs; true overs counted", () => {
    const clean = measureClipping(mono(sine(220, 0.5, 1)));
    expect(clean.runCount.value).toBe(0);
    const clipped = sine(220, 1.5, 1).map((v) => Math.max(-0.95, Math.min(0.95, v)));
    const r = measureClipping(mono(clipped));
    expect(r.runCount.value).toBeGreaterThan(100);
    expect(r.trueOverCount.value).toBeGreaterThan(0);
  });
});

describe("noise / SNR", () => {
  const sigma = 0.001; // -60 dBFS RMS
  const make = (): { file: Pcm; print: Pcm } => {
    const n = noise(sigma, 8, 11);
    const speech = sine(400, 0.1, 4);
    for (let i = 0; i < speech.length; i++) n[2 * SR + i] = n[2 * SR + i]! + speech[i]!;
    return { file: mono(n), print: mono(noise(sigma, 2.5, 12)) };
  };
  it("recovers the noise floor and SNR", () => {
    const { file, print } = make();
    const r = measureNoise(file, print);
    expect(r.noiseFloor.value).toBeCloseTo(-60, 0);
    // speech RMS = 0.1/sqrt2 = -23 dBFS -> SNR ~ 37 dB
    expect(r.snr.value).toBeGreaterThan(36);
    expect(r.snr.value).toBeLessThan(38);
  });
  it("throws without a print, with a short print, and with a non-stationary print", () => {
    const { file, print } = make();
    expect(() => measureNoise(file, null)).toThrow(/required/);
    expect(() => measureNoise(file, mono(print.channels[0]!.slice(0, SR)))).toThrow(/Noise print is/);
    const bumpy = print.channels[0]!.slice();
    for (let i = 0; i < 4800; i++) bumpy[SR + i] = bumpy[SR + i]! + sine(200, 0.2, 0.1)[i]!;
    expect(() => measureNoise(file, mono(bumpy))).toThrow(/not stationary/);
  });
});

describe("failure contract", () => {
  it("rejects NaN and empty input", () => {
    const bad = sine(100, 0.5, 1);
    bad[5] = NaN;
    expect(() => measureDcOffset(mono(bad))).toThrow(/Non-finite/);
    expect(() => measureDcOffset({ sampleRate: SR, channels: [] })).toThrow(MeasurementError);
  });
  it("measureAll reports failures explicitly instead of zeros", () => {
    const r = measureAll(mono(sine(1000, 0.5, 5)), null);
    expect(r.noise.ok).toBe(false);
    expect(r.correlation.ok).toBe(false);
    if (!r.noise.ok) expect(r.noise.error.code).toBe("NO_NOISE_PRINT");
    expect(r.loudness.ok).toBe(true);
  });
});
