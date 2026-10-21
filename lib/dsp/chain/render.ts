import { CHAIN_ORDER, STAGE_KIND, type ChainConfig, type StageId } from "../config";
import { isBypassed, type BypassMap } from "../configUtil";
import type { ChainWorkerClient } from "./chainClient";
import type { JsStageId } from "./jsStages";
import { prepareMono, renderNativeSegment, type NativeStageId } from "./native";
import type { ChainAnalysis, ConfirmedPlosives, StageReport } from "./types";

/**
 * Orchestrates the chain. Analysis (clipping check, noise print, pop detection) reads a mono,
 * internal-rate copy of the source and changes nothing. Rendering walks CHAIN_ORDER; consecutive
 * stages of the same kind are batched into one segment: native -> one OfflineAudioContext render,
 * js -> one worker round trip. The source AudioBuffer is never mutated and the result is a NEW AudioBuffer.
 */
export async function analyzeSource(
  src: AudioBuffer,
  cfg: ChainConfig,
  worker: ChainWorkerClient,
  opts: { bypass?: BypassMap; printStartSec?: number | null; printLengthSec?: number | null } = {},
): Promise<ChainAnalysis> {
  const prepared = await prepareMono(src, cfg.internalSampleRate);
  const result = await worker.analyze({
    x: prepared,
    sampleRate: cfg.internalSampleRate,
    cfg,
    bypass: opts.bypass,
    printStartSec: opts.printStartSec ?? null,
    printLengthSec: opts.printLengthSec ?? null,
  });
  return { ...result, prepared };
}

export interface ChainRenderResult {
  processed: AudioBuffer;
  reports: StageReport[];
}

function assertFinite(x: Float32Array, where: string): void {
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]!)) throw new Error(`${where}: non-finite sample at ${i}.`);
  }
}

export async function renderChain(
  analysis: ChainAnalysis,
  cfg: ChainConfig,
  worker: ChainWorkerClient,
  opts: { bypass?: BypassMap; confirmed?: ConfirmedPlosives | null } = {},
): Promise<ChainRenderResult> {
  const sr = analysis.sampleRate;
  const reports = new Map<StageId, StageReport>();
  let x: Float32Array = analysis.prepared.slice();

  const noiseFloor = analysis.noisePrint?.verdict.ok ? analysis.noisePrint.verdict.noiseFloorDbfs : null;

  let seg: { kind: "native" | "js"; ids: StageId[] } | null = null;
  const flush = async () => {
    if (!seg) return;
    if (seg.kind === "native") {
      const ids = seg.ids as NativeStageId[];
      const r = await renderNativeSegment(x, sr, ids, cfg, opts.bypass);
      x = r.out;
      for (const id of ids) {
        reports.set(id, isBypassed(cfg, id, opts.bypass) ? { id, status: "bypassed" } : { id, status: "applied" });
      }
    } else {
      const r = await worker.run({
        ids: seg.ids as JsStageId[],
        x,
        sampleRate: sr,
        cfg,
        bypass: opts.bypass,
        noiseFloorDbfs: noiseFloor,
        confirmed: opts.confirmed ?? null,
      });
      x = r.out;
      for (const rep of r.reports) reports.set(rep.id, rep);
    }
    assertFinite(x, `segment ${seg.ids.join("+")}`);
    seg = null;
  };

  for (const id of CHAIN_ORDER) {
    const kind = STAGE_KIND[id];
    if (kind === "analysis") {
      reports.set(id, analysisReport(id, analysis, cfg, opts.bypass));
      continue;
    }
    if (seg && seg.kind !== kind) await flush();
    seg ??= { kind, ids: [] };
    seg.ids.push(id);
  }
  await flush();

  const processed = new AudioBuffer({ length: x.length, sampleRate: sr, numberOfChannels: 1 });
  processed.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
  return { processed, reports: CHAIN_ORDER.map((id) => reports.get(id)!) };
}

function analysisReport(id: StageId, a: ChainAnalysis, cfg: ChainConfig, bypass?: BypassMap): StageReport {
  if (isBypassed(cfg, id, bypass)) return { id, status: "bypassed" };
  if (id === "clippingCheck" && a.clipping) {
    return {
      id,
      status: "analysis",
      note: a.clipped ? "Clipping detected. It can't be undone here; pop detection is made stricter." : "No clipping detected.",
      metrics: { runs: a.clipping.runCount.value, trueOvers: a.clipping.trueOverCount.value },
    };
  }
  if (id === "noisePrint" && a.noisePrint) {
    const v = a.noisePrint.verdict;
    return {
      id,
      status: "analysis",
      note: v.ok ? "Noise print accepted." : `Noise print rejected: ${v.rejections.map((r) => r.message).join(" ")}`,
      metrics: v.noiseFloorDbfs === null ? undefined : { noiseFloorDbfs: v.noiseFloorDbfs },
    };
  }
  return { id, status: "analysis" };
}
