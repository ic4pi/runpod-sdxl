import { CHAIN_ORDER, STAGE_KIND, type ChainConfig, type StageId } from "../config";
import { isBypassed, type BypassMap } from "../configUtil";
import { applyCompressor } from "./compressor";
import { applyDeess } from "./deess";
import { applyDeplosive } from "./deplosive";
import { applyExpander } from "./expander";
import { applyLimiter } from "./limiter";
import type { RnnoiseEngine } from "./rnnoise";
import type { ConfirmedPlosives, StageReport } from "./types";

/** Sample-domain stages. Pure and synchronous, so they run identically in the worker and in Node tests. */
export interface JsRunContext {
  cfg: ChainConfig;
  bypass?: BypassMap;
  sampleRate: number;
  /** From a validated noise print; null when there is none. */
  noiseFloorDbfs: number | null;
  /** De-plosive applies only when this is provided. */
  confirmed: ConfirmedPlosives | null;
  rnnoise: RnnoiseEngine | null;
}

export type JsStageId = Extract<StageId, "noiseReduction" | "expander" | "deplosive" | "deess" | "compressor" | "limiter">;

export const JS_STAGE_IDS: readonly JsStageId[] = CHAIN_ORDER.filter((id): id is JsStageId => STAGE_KIND[id] === "js");

export function runJsStage(id: JsStageId, x: Float32Array, ctx: JsRunContext): { out: Float32Array; report: StageReport } {
  const { cfg, sampleRate } = ctx;
  if (isBypassed(cfg, id, ctx.bypass)) return { out: x, report: { id, status: "bypassed" } };
  if (x.length === 0) throw new Error(`Stage ${id}: empty input.`);

  switch (id) {
    case "noiseReduction": {
      if (!ctx.rnnoise) throw new Error("noiseReduction: RNNoise engine not loaded (refusing to substitute another denoiser).");
      if (sampleRate !== cfg.stages.noiseReduction.params.rnnoise.sampleRate) {
        throw new Error(`noiseReduction: RNNoise needs ${cfg.stages.noiseReduction.params.rnnoise.sampleRate} Hz, got ${sampleRate}.`);
      }
      const { out } = ctx.rnnoise.process(x);
      return { out, report: { id, status: "applied", note: "RNNoise (WASM)" } };
    }
    case "expander": {
      const p = cfg.stages.expander.params;
      const useAbs = p.thresholdMode === "absolute" || ctx.noiseFloorDbfs === null;
      const thr = useAbs ? p.absoluteThresholdDbfs : ctx.noiseFloorDbfs! + p.thresholdOverNoiseDb;
      const r = applyExpander(x, sampleRate, p, thr);
      let minGain = 1;
      for (const g of r.gain) if (g < minGain) minGain = g;
      return {
        out: r.out,
        report: {
          id,
          status: "applied",
          note: useAbs && p.thresholdMode !== "absolute" ? "No valid noise print: used the absolute fallback threshold." : undefined,
          metrics: { thresholdDbfs: thr, minGain },
        },
      };
    }
    case "deplosive": {
      if (!ctx.confirmed) {
        return { out: x, report: { id, status: "awaiting-confirmation", note: "Detected pops must be confirmed before any change is made." } };
      }
      const r = applyDeplosive(x, sampleRate, ctx.confirmed, cfg.stages.deplosive.params.apply);
      return {
        out: r.out,
        report: r.appliedEvents === 0
          ? { id, status: "skipped", note: "No pops were confirmed." }
          : { id, status: "applied", metrics: { events: r.appliedEvents } },
      };
    }
    case "deess": {
      const r = applyDeess(x, sampleRate, cfg.stages.deess.params);
      return { out: r.out, report: { id, status: "applied", metrics: { maxReductionDb: r.maxReductionDb } } };
    }
    case "compressor": {
      const r = applyCompressor(x, sampleRate, cfg.stages.compressor.params);
      return { out: r.out, report: { id, status: "applied", metrics: { maxReductionDb: r.maxReductionDb } } };
    }
    case "limiter": {
      const r = applyLimiter(x, sampleRate, cfg.stages.limiter.params);
      return { out: r.out, report: { id, status: "applied", metrics: { maxReductionDb: r.maxReductionDb } } };
    }
  }
}

/** Runs the given js stages in the order given (callers pass them in chain order). */
export function runJsStages(ids: readonly JsStageId[], x: Float32Array, ctx: JsRunContext): { out: Float32Array; reports: StageReport[] } {
  let cur = x;
  const reports: StageReport[] = [];
  for (const id of ids) {
    const r = runJsStage(id, cur, ctx);
    cur = r.out;
    reports.push(r.report);
  }
  return { out: cur, reports };
}
