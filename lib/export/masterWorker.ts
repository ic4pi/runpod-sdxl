/// <reference lib="webworker" />
import type { ChainConfig } from "../dsp/config";
import { masterForExport, type MasterResult } from "./master";

export interface MasterRequest {
  id: number;
  pcm: Float32Array;
  sampleRate: number;
  cfg: ChainConfig;
  ceilingMarginDb: number;
}
export type MasterResponse = ({ id: number; ok: true } & MasterResult) | { id: number; ok: false; message: string };

self.onmessage = (e: MessageEvent<MasterRequest>) => {
  const { id, pcm, sampleRate, cfg, ceilingMarginDb } = e.data;
  let res: MasterResponse;
  try {
    res = { id, ok: true, ...masterForExport(pcm, sampleRate, cfg, { ceilingMarginDb }) };
  } catch (err) {
    res = { id, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const transfer = res.ok ? [res.pcm.buffer] : [];
  (self as unknown as Worker).postMessage(res, transfer);
};
