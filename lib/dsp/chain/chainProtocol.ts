import type { ChainConfig } from "../config";
import type { BypassMap } from "../configUtil";
import type { AnalysisResult } from "./analysis";
import type { JsStageId } from "./jsStages";
import type { ConfirmedPlosives, StageReport } from "./types";

export type ChainWorkerRequest =
  | {
      id: number;
      op: "analyze";
      x: Float32Array;
      sampleRate: number;
      cfg: ChainConfig;
      bypass?: BypassMap;
      printStartSec: number | null;
      printLengthSec: number | null;
      wasmBytes: ArrayBuffer | null;
    }
  | {
      id: number;
      op: "run";
      ids: JsStageId[];
      x: Float32Array;
      sampleRate: number;
      cfg: ChainConfig;
      bypass?: BypassMap;
      noiseFloorDbfs: number | null;
      confirmed: ConfirmedPlosives | null;
      wasmBytes: ArrayBuffer | null;
    };

export type ChainWorkerResponse =
  | { id: number; ok: true; op: "analyze"; result: AnalysisResult }
  | { id: number; ok: true; op: "run"; out: Float32Array; reports: StageReport[] }
  | { id: number; ok: false; message: string };
