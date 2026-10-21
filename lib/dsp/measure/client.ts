import type { MeasureReport } from "./index";
import type { MeasureThresholds } from "./thresholds";
import type { Pcm } from "./types";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

export function pcmFromAudioBuffer(buf: AudioBuffer): Pcm {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
  return { sampleRate: buf.sampleRate, channels };
}

export interface MeasureClient {
  /** Copies the input, so the caller keeps its buffers. Runs off the main thread. */
  measure(pcm: Pcm | AudioBuffer, noisePrint?: Pcm | AudioBuffer | null, thresholds?: MeasureThresholds): Promise<MeasureReport>;
  terminate(): void;
}

const asPcm = (x: Pcm | AudioBuffer): Pcm => ("numberOfChannels" in x ? pcmFromAudioBuffer(x) : x);
const copy = (p: Pcm) => ({ sampleRate: p.sampleRate, channels: p.channels.map((c) => c.slice()) });

export function createMeasureClient(): MeasureClient {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: MeasureReport) => void; reject: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.report);
    else p.reject(new Error(e.data.message));
  };
  worker.onerror = (e) => {
    const err = new Error(`Measurement worker crashed: ${e.message}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return {
    measure(input, noisePrint, thresholds) {
      const pcm = copy(asPcm(input));
      const print = noisePrint ? copy(asPcm(noisePrint)) : null;
      const id = nextId++;
      const req: WorkerRequest = { id, sampleRate: pcm.sampleRate, channels: pcm.channels, noisePrint: print, thresholds };
      const transfer = [...pcm.channels.map((c) => c.buffer), ...(print ? print.channels.map((c) => c.buffer) : [])];
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage(req, transfer);
      });
    },
    terminate() {
      worker.terminate();
    },
  };
}
