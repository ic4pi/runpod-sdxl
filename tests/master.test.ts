/** Export-mastering tests. AUDIO IS SYNTHETIC (generated vocal, tones, clicks); no real recordings. */
import { describe, expect, it } from "vitest";
import { generateSyntheticVocal } from "../lib/dsp/defects/syntheticVocal";
import { parseWav } from "../lib/dsp/fixtures/wav";
import { measureLoudness } from "../lib/dsp/measure/loudness";
import { measureTruePeak } from "../lib/dsp/measure/truePeak";
import { masterForExport } from "../lib/export/master";
import { encodeMonoWav } from "../lib/export/wav";
import { cfgCopy, SR, sine } from "./helpers";

const cfg = cfgCopy();
const TARGET = cfg.export.targetLufs;
const CEIL = cfg.stages.limiter.params.ceilingDbtp;
const lufs = (x: Float32Array) => measureLoudness({ sampleRate: SR, channels: [x] }).integrated.value;
const tp = (x: Float32Array) => measureTruePeak({ sampleRate: SR, channels: [x] }).truePeak.value;
const vocal = () => generateSyntheticVocal({ seed: 2, f0Base: 165 }).channels[0]!;
const gain = (x: Float32Array, db: number) => x.map((v) => v * Math.pow(10, db / 20));

describe("target comes from config, not a literal", () => {
  it("targetLufs and the ceiling are read from config.ts", () => {
    expect(TARGET).toBe(-14);
    expect(CEIL).toBe(-1);
    const c2 = cfgCopy();
    c2.export.targetLufs = -18;
    const r = masterForExport(vocal(), SR, c2);
    expect(r.report.targetLufs).toBe(-18);
    expect(Math.abs(lufs(r.pcm) - -18)).toBeLessThanOrEqual(c2.export.loudnessToleranceLu);
  });
});

describe("masterForExport: measure -> gain -> RE-RUN limiter -> verify", () => {
  it.each([-14, -6, 0, 4])("hits -14 LUFS with the ceiling intact from a %i dB-trimmed start (quiet to hot)", (trim) => {
    const x = gain(vocal(), trim);
    const r = masterForExport(x, SR, cfg);
    expect(r.report.status).toBe("met");
    expect(Math.abs(lufs(r.pcm) - TARGET)).toBeLessThanOrEqual(cfg.export.loudnessToleranceLu);
    expect(tp(r.pcm)).toBeLessThanOrEqual(CEIL + 0.05);
    expect(r.report.outputLufs).toBeCloseTo(lufs(r.pcm), 6);
    expect(r.pcm.length).toBe(x.length);
    expect(r.sampleRate).toBe(SR);
  });

  it("a file that needs gain to reach -14 LUFS but would clip is limited, not clipped, and still reaches the target", () => {
    // vocal body (about -17.8 LUFS) plus rare loud clicks at -0.9 dBFS: +3.8 dB of gain would push the clicks over the ceiling
    const x = vocal().slice();
    for (let i = 24000; i < x.length; i += 96000) x[i] = 0.9;
    const before = tp(x);
    expect(before).toBeGreaterThan(CEIL); // the naive gain WOULD clip these
    const naive = gain(x, TARGET - lufs(x));
    expect(tp(naive)).toBeGreaterThan(CEIL + 1); // a -14 LUFS file that clips: the bug this order of operations prevents
    const r = masterForExport(x, SR, cfg);
    expect(r.report.status).toBe("met");
    expect(tp(r.pcm)).toBeLessThanOrEqual(CEIL + 0.05);
    expect(Math.abs(lufs(r.pcm) - TARGET)).toBeLessThanOrEqual(cfg.export.loudnessToleranceLu);
    expect(r.report.limiterMaxReductionDb).toBeGreaterThan(1); // the limiter actually worked
    expect(r.report.limiterMaxReductionDb).toBeLessThanOrEqual(cfg.export.maxLimiterReductionDb);
  });

  it("CONFLICT: very dynamic material (quiet body, huge clicks): the ceiling wins, delivered quieter than target, and it says so", () => {
    const x = gain(vocal(), -26).slice();
    for (let i = 0; i < x.length; i += 48000) x[i] = 0.9;
    const r = masterForExport(x, SR, cfg);
    expect(r.report.status).toBe("ceiling-limited");
    expect(tp(r.pcm)).toBeLessThanOrEqual(CEIL + 0.05);
    expect(r.report.limiterMaxReductionDb).toBeLessThanOrEqual(cfg.export.maxLimiterReductionDb + 1e-6);
    expect(lufs(r.pcm)).toBeLessThan(TARGET - cfg.export.loudnessToleranceLu);
    expect(r.report.note).toMatch(/ceiling wins/i);
    expect(r.report.note).toMatch(/LU short/);
  });

  it("louder-than-target material is turned DOWN to the target", () => {
    const hot = gain(vocal(), 8);
    expect(lufs(hot)).toBeGreaterThan(TARGET + 3);
    const r = masterForExport(hot, SR, cfg);
    expect(r.report.gainDb).toBeLessThan(0);
    expect(Math.abs(lufs(r.pcm) - TARGET)).toBeLessThanOrEqual(cfg.export.loudnessToleranceLu);
    expect(r.report.status).toBe("met");
  });

  it("the limiter pass runs even when the user bypassed the limiter stage", () => {
    const c2 = cfgCopy();
    c2.stages.limiter.bypass = true;
    const x = vocal().slice();
    for (let i = 24000; i < x.length; i += 96000) x[i] = 0.9;
    const r = masterForExport(x, SR, c2, {});
    expect(tp(r.pcm)).toBeLessThanOrEqual(CEIL + 0.05);
  });

  it("a format margin lowers the ceiling (MP3 decoders can overshoot)", () => {
    const x = vocal().slice();
    for (let i = 24000; i < x.length; i += 96000) x[i] = 0.9;
    const r = masterForExport(x, SR, cfg, { ceilingMarginDb: 0.5 });
    expect(r.report.ceilingDbtp).toBe(CEIL - 0.5);
    expect(tp(r.pcm)).toBeLessThanOrEqual(CEIL - 0.5 + 0.05);
  });

  it("clips shorter than the integrated-loudness minimum get the limiter only, and say so", () => {
    const short = sine(440, 1.4, 2); // 2 s, over the ceiling
    const r = masterForExport(short, SR, cfg);
    expect(r.report.status).toBe("too-short-to-measure");
    expect(r.report.outputLufs).toBeNull();
    expect(r.report.note).toMatch(/shorter than 3 s/);
    expect(tp(r.pcm)).toBeLessThanOrEqual(CEIL + 0.05);
  });

  it("silence cannot be exported to a loudness target: throws, no fake success", () => {
    expect(() => masterForExport(new Float32Array(5 * SR), SR, cfg)).toThrow();
  });

  it("after 16-bit TPDF-dithered WAV encoding and decoding, both numbers still hold", () => {
    const x = vocal().slice();
    for (let i = 24000; i < x.length; i += 96000) x[i] = 0.9;
    const m = masterForExport(x, SR, cfg);
    const decoded = parseWav(encodeMonoWav(m.pcm, SR, cfg.export.wav)).channels[0]!;
    expect(decoded.length).toBe(m.pcm.length);
    expect(Math.abs(lufs(decoded) - TARGET)).toBeLessThanOrEqual(cfg.export.loudnessToleranceLu);
    expect(tp(decoded)).toBeLessThanOrEqual(CEIL + 0.05);
  });
});
