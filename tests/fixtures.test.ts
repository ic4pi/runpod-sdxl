import { describe, expect, it } from "vitest";
import { analyzeSignal } from "../lib/dsp/chain/analysis";
import { runJsStages } from "../lib/dsp/chain/jsStages";
import { loadFixtures } from "../lib/dsp/fixtures/loadFixtures";
import { measureAll } from "../lib/dsp/measure";
import { cfgCopy, loadEngine } from "./helpers";

/**
 * Runs on whatever real recordings are in /fixtures/audio (see fixtures/audio/README.md).
 * Node can't resample, so only 48 kHz WAVs run here; the browser UI (/repair) handles every format and rate.
 * With no files this suite is skipped, and says so.
 */
const fixtures = loadFixtures();
describe.skipIf(fixtures.length === 0)(`real-recording fixtures (${fixtures.length} found)`, () => {
  for (const f of fixtures) {
    const cfg = cfgCopy();
    const usable = f.pcm && f.pcm.sampleRate === cfg.internalSampleRate;
    it.skipIf(!usable)(`${f.name}${usable ? "" : ` [skipped: ${f.skipReason ?? `${f.pcm?.sampleRate} Hz, Node path needs ${cfg.internalSampleRate} Hz`}]`}`, async () => {
      const pcm = f.pcm!;
      const n = pcm.channels[0]!.length;
      const mono = new Float32Array(n);
      for (const ch of pcm.channels) for (let i = 0; i < n; i++) mono[i] = mono[i]! + ch[i]! / pcm.channels.length;
      const report = measureAll({ sampleRate: pcm.sampleRate, channels: [mono] }, null);
      const engine = await loadEngine();
      const a = analyzeSignal({ x: mono, sampleRate: pcm.sampleRate, cfg, printStartSec: null, printLengthSec: null, rnnoise: engine });
      const noiseFloor = a.noisePrint?.verdict.ok ? a.noisePrint.verdict.noiseFloorDbfs : null;
      const { out, reports } = runJsStages(["noiseReduction", "expander", "deplosive", "deess", "compressor", "limiter"], mono, {
        cfg, sampleRate: pcm.sampleRate, noiseFloorDbfs: noiseFloor, confirmed: null, rnnoise: engine,
      });
      // eslint-disable-next-line no-console
      console.log(`[fixture ${f.name}] clipped=${a.clipped} printOk=${a.noisePrint?.verdict.ok} floor=${noiseFloor?.toFixed(1)} pops=${a.plosiveCandidates.length} lufs=${report.loudness.ok ? report.loudness.value.integrated.value.toFixed(1) : "n/a"} stages=${reports.map((r) => `${r.id}:${r.status}`).join(",")}`);
      expect(out.length).toBe(n);
      expect(out.every(Number.isFinite)).toBe(true);
      expect(reports.find((r) => r.id === "deplosive")?.status).toBe("awaiting-confirmation");
    });
  }
});
