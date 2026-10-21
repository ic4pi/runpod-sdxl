/// <reference lib="webworker" />
import { analyzeSignal } from "./analysis";
import type { ChainWorkerRequest, ChainWorkerResponse } from "./chainProtocol";
import { runJsStages } from "./jsStages";
import { createRnnoiseEngine, type RnnoiseEngine } from "./rnnoise";
import type { ChainConfig } from "../config";

let engine: RnnoiseEngine | null = null;

async function getEngine(cfg: ChainConfig, wasmBytes: ArrayBuffer | null): Promise<RnnoiseEngine> {
  if (engine) return engine;
  if (!wasmBytes) throw new Error("RNNoise wasm bytes were not supplied to the worker.");
  engine = await createRnnoiseEngine(wasmBytes, cfg.stages.noiseReduction.params.rnnoise);
  return engine;
}

self.onmessage = async (e: MessageEvent<ChainWorkerRequest>) => {
  const req = e.data;
  let res: ChainWorkerResponse;
  try {
    const rn = await getEngine(req.cfg, req.wasmBytes);
    if (req.op === "analyze") {
      const result = analyzeSignal({
        x: req.x,
        sampleRate: req.sampleRate,
        cfg: req.cfg,
        bypass: req.bypass,
        printStartSec: req.printStartSec,
        printLengthSec: req.printLengthSec,
        rnnoise: rn,
      });
      res = { id: req.id, ok: true, op: "analyze", result };
    } else {
      const { out, reports } = runJsStages(req.ids, req.x, {
        cfg: req.cfg,
        bypass: req.bypass,
        sampleRate: req.sampleRate,
        noiseFloorDbfs: req.noiseFloorDbfs,
        confirmed: req.confirmed,
        rnnoise: rn,
      });
      res = { id: req.id, ok: true, op: "run", out, reports };
    }
  } catch (err) {
    res = { id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(res);
};
