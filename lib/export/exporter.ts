import type { ChainConfig } from "../dsp/config";
import { buildFilename } from "./filename";
import type { MasterReport, MasterResult } from "./master";
import type { MasterRequest, MasterResponse } from "./masterWorker";
import { encodeMonoWav } from "./wav";

export type ExportFormat = "wav" | "mp3";

export interface ExportResult {
  blob: Blob;
  filename: string;
  format: ExportFormat;
  sampleRate: number;
  channels: 1;
  report: MasterReport;
}

function runMaster(pcm: Float32Array, sampleRate: number, cfg: ChainConfig, ceilingMarginDb: number): Promise<MasterResult> {
  const w = new Worker(new URL("./masterWorker.ts", import.meta.url), { type: "module" });
  const copy = pcm.slice();
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<MasterResponse>) => {
      w.terminate();
      if (e.data.ok) resolve({ pcm: e.data.pcm, sampleRate: e.data.sampleRate, report: e.data.report });
      else reject(new Error(e.data.message));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(`Export worker crashed: ${e.message}`));
    };
    const req: MasterRequest = { id: 1, pcm: copy, sampleRate, cfg, ceilingMarginDb };
    w.postMessage(req, [copy.buffer]);
  });
}

function runMp3(pcm: Float32Array, sampleRate: number, cfg: ChainConfig): Promise<Uint8Array> {
  const w = new Worker(cfg.export.mp3.workerUrl); // classic worker: loads the unmodified LAME-derived encoder from its own file
  const copy = pcm.slice();
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<{ ok: true; mp3: Uint8Array } | { ok: false; message: string }>) => {
      w.terminate();
      if (e.data.ok) resolve(e.data.mp3);
      else reject(new Error(`MP3 encoding failed: ${e.data.message}`));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(`MP3 worker failed to start: ${e.message || "could not load the encoder"}`));
    };
    w.postMessage({ pcm: copy, sampleRate, bitrateKbps: cfg.export.mp3.bitrateKbps, chunkSamples: cfg.export.mp3.chunkSamples }, [copy.buffer]);
  });
}

/**
 * Export the processed buffer. Order: measure LUFS -> gain -> re-run limiter at the ceiling (master worker)
 * -> encode. Output is always 48 kHz MONO: the chain is mono and nothing is upsampled to fake stereo.
 */
export async function exportAudio(args: {
  pcm: Float32Array;
  sampleRate: number;
  cfg: ChainConfig;
  format: ExportFormat;
  artist: string;
  track: string;
  presetId: string;
}): Promise<ExportResult> {
  const { cfg, format } = args;
  const margin = format === "mp3" ? cfg.export.mp3.ceilingMarginDb : 0;
  const mastered = await runMaster(args.pcm, args.sampleRate, cfg, margin);
  let blob: Blob;
  if (format === "wav") {
    blob = new Blob([encodeMonoWav(mastered.pcm, mastered.sampleRate, cfg.export.wav)], { type: "audio/wav" });
  } else {
    const mp3 = await runMp3(mastered.pcm, mastered.sampleRate, cfg);
    blob = new Blob([mp3 as Uint8Array<ArrayBuffer>], { type: "audio/mpeg" });
  }
  return {
    blob,
    filename: buildFilename({ artist: args.artist, track: args.track, presetId: args.presetId, ext: format }, cfg.export.filename),
    format,
    sampleRate: mastered.sampleRate,
    channels: 1,
    report: mastered.report,
  };
}
