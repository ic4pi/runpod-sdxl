import type { MeasureReport } from "./index";
import type { MeasureThresholds } from "./thresholds";

export interface WorkerRequest {
  id: number;
  sampleRate: number;
  channels: Float32Array[];
  noisePrint?: { sampleRate: number; channels: Float32Array[] } | null;
  thresholds?: MeasureThresholds;
}

export type WorkerResponse =
  | { id: number; ok: true; report: MeasureReport }
  | { id: number; ok: false; message: string };
