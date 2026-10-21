/// <reference lib="webworker" />
import { measureAll } from "./index";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, sampleRate, channels, noisePrint, thresholds } = e.data;
  let res: WorkerResponse;
  try {
    const report = measureAll({ sampleRate, channels }, noisePrint ?? null, thresholds);
    res = { id, ok: true, report };
  } catch (err) {
    res = { id, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(res);
};
