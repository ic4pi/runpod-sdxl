import type { ChainConfig } from "../config";
import type { BypassMap } from "../configUtil";
import type { AnalysisResult } from "./analysis";
import type { ChainWorkerRequest, ChainWorkerResponse } from "./chainProtocol";
import type { JsStageId } from "./jsStages";
import type { ConfirmedPlosives, StageReport } from "./types";

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

export interface ChainWorkerClient {
  analyze(a: {
    x: Float32Array;
    sampleRate: number;
    cfg: ChainConfig;
    bypass?: BypassMap;
    printStartSec: number | null;
    printLengthSec: number | null;
  }): Promise<AnalysisResult>;
  run(a: {
    ids: JsStageId[];
    x: Float32Array;
    sampleRate: number;
    cfg: ChainConfig;
    bypass?: BypassMap;
    noiseFloorDbfs: number | null;
    confirmed: ConfirmedPlosives | null;
  }): Promise<{ out: Float32Array; reports: StageReport[] }>;
  terminate(): void;
}

/** Off-main-thread client for the sample-domain stages. RNNoise wasm bytes are fetched once from config.wasmUrl. */
export function createChainWorkerClient(): ChainWorkerClient {
  const worker = new Worker(new URL("./chainWorker.ts", import.meta.url), { type: "module" });
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  let wasmCache: Promise<ArrayBuffer> | null = null;
  worker.onmessage = (e: MessageEvent<ChainWorkerResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data);
    else p.reject(new Error(e.data.message));
  };
  worker.onerror = (e) => {
    const err = new Error(`Chain worker crashed: ${e.message}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  async function wasm(cfg: ChainConfig): Promise<ArrayBuffer> {
    wasmCache ??= fetch(cfg.stages.noiseReduction.params.rnnoise.wasmUrl).then((r) => {
      if (!r.ok) throw new Error(`Could not load RNNoise wasm (${r.status}) from ${r.url}`);
      return r.arrayBuffer();
    });
    return wasmCache;
  }

  async function send(req: DistributiveOmit<ChainWorkerRequest, "id" | "wasmBytes">, cfg: ChainConfig): Promise<any> {
    const bytes = (await wasm(cfg)).slice(0);
    const id = nextId++;
    const full = { ...req, id, wasmBytes: bytes } as ChainWorkerRequest;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(full, [bytes, (full as any).x.buffer]);
    });
  }

  return {
    async analyze(a) {
      const r = await send({ op: "analyze", ...a, x: a.x.slice() }, a.cfg);
      return r.result;
    },
    async run(a) {
      const r = await send({ op: "run", ...a, x: a.x.slice() }, a.cfg);
      return { out: r.out, reports: r.reports };
    },
    terminate: () => worker.terminate(),
  };
}
