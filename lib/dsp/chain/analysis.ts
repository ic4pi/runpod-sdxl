import type { ChainConfig } from "../config";
import { isBypassed, type BypassMap } from "../configUtil";
import { runClippingCheck } from "./clippingCheck";
import { detectPlosives } from "./deplosive";
import { validateNoisePrint } from "./noisePrint";
import type { RnnoiseEngine } from "./rnnoise";
import type { ChainAnalysis } from "./types";

export type AnalysisResult = Omit<ChainAnalysis, "prepared">;

/** Start (seconds) of the quietest `lengthSec` window, measured on `blockSec` blocks. Convenience default for the print; it is still validated. */
export function findQuietestWindowStart(x: Float32Array, sampleRate: number, lengthSec: number, blockSec: number): number {
  const hop = Math.round(blockSec * sampleRate);
  const nb = Math.floor(x.length / hop);
  const wb = Math.round(lengthSec / blockSec);
  if (nb < wb) throw new Error(`Audio (${(x.length / sampleRate).toFixed(2)} s) is shorter than a ${lengthSec} s noise print.`);
  const ms = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let i = b * hop; i < (b + 1) * hop; i++) s += x[i]! * x[i]!;
    ms[b] = s / hop;
  }
  let best = 0;
  let bestSum = Infinity;
  for (let b = 0; b + wb <= nb; b++) {
    let s = 0;
    for (let k = 0; k < wb; k++) s += ms[b + k]!;
    if (s < bestSum) {
      bestSum = s;
      best = b;
    }
  }
  return (best * hop) / sampleRate;
}

export interface AnalyzeRequest {
  /** Mono, internal rate. */
  x: Float32Array;
  sampleRate: number;
  cfg: ChainConfig;
  bypass?: BypassMap;
  /** Print location. null = pick the quietest window. */
  printStartSec: number | null;
  printLengthSec: number | null;
  rnnoise: RnnoiseEngine | null;
}

/** Clipping check, noise-print validation and de-plosive detection. Reads audio, never changes it. */
export function analyzeSignal(r: AnalyzeRequest): AnalysisResult {
  const { x, sampleRate: sr, cfg } = r;
  let clipping: AnalysisResult["clipping"] = null;
  let clipped = false;
  if (!isBypassed(cfg, "clippingCheck", r.bypass)) {
    const c = runClippingCheck(x, sr, cfg.stages.clippingCheck.params);
    clipping = c.result;
    clipped = c.clipped;
  }

  let noisePrint: AnalysisResult["noisePrint"] = null;
  if (!isBypassed(cfg, "noisePrint", r.bypass)) {
    const pp = cfg.stages.noisePrint.params;
    const lengthSec = r.printLengthSec ?? pp.minSec;
    const startSec = r.printStartSec ?? findQuietestWindowStart(x, sr, lengthSec, pp.blockSec);
    const a = Math.round(startSec * sr);
    const print = x.slice(a, a + Math.round(lengthSec * sr));
    const vad = pp.vad.enabled && r.rnnoise ? r.rnnoise.process(print).vad : null;
    noisePrint = { startSec, lengthSec: print.length / sr, verdict: validateNoisePrint(print, sr, pp, vad) };
  }

  const plosiveCandidates = isBypassed(cfg, "deplosive", r.bypass)
    ? []
    : detectPlosives(x, sr, cfg.stages.deplosive.params.detect, clipped);
  return { sampleRate: sr, clipping, clipped, noisePrint, plosiveCandidates };
}
