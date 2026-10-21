import type { ChainConfig } from "../config";
import createRNNWasmModule, { type RnnoiseWasmModule } from "./vendor/rnnoiseGlue.js";

export type RnnoiseParams = ChainConfig["stages"]["noiseReduction"]["params"]["rnnoise"];

export interface RnnoiseEngine {
  /** Input must be mono at `params.sampleRate`. Output has the same length, delay-compensated. */
  process(x: Float32Array): { out: Float32Array; vad: Float32Array };
}

/**
 * RNNoise (xiph, via Jitsi's emscripten build) running as WASM. `wasmBinary` is the bytes of
 * public/wasm/rnnoise.wasm; the caller fetches (browser) or reads (Node) it.
 */
export async function createRnnoiseEngine(wasmBinary: ArrayBuffer | Uint8Array, p: RnnoiseParams): Promise<RnnoiseEngine> {
  const mod: RnnoiseWasmModule = await createRNNWasmModule({ wasmBinary });
  const frameBytes = p.frameSamples * Float32Array.BYTES_PER_ELEMENT;
  return {
    process(x) {
      const n = x.length;
      const frames = Math.ceil((n + p.latencySamples) / p.frameSamples);
      const padded = frames * p.frameSamples;
      const raw = new Float32Array(padded);
      const vad = new Float32Array(frames);
      const state = mod._rnnoise_create();
      const inPtr = mod._malloc(frameBytes);
      const outPtr = mod._malloc(frameBytes);
      try {
        for (let f = 0; f < frames; f++) {
          const start = f * p.frameSamples;
          const inBase = inPtr >> 2;
          for (let i = 0; i < p.frameSamples; i++) {
            const s = start + i;
            mod.HEAPF32[inBase + i] = (s < n ? x[s]! : 0) * p.pcmScale;
          }
          vad[f] = mod._rnnoise_process_frame(state, outPtr, inPtr);
          const outBase = outPtr >> 2;
          for (let i = 0; i < p.frameSamples; i++) raw[start + i] = mod.HEAPF32[outBase + i]! / p.pcmScale;
        }
      } finally {
        mod._free(inPtr);
        mod._free(outPtr);
        mod._rnnoise_destroy(state);
      }
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const den = raw[i + p.latencySamples]!;
        out[i] = p.wet * den + (1 - p.wet) * x[i]!;
      }
      return { out, vad };
    },
  };
}
