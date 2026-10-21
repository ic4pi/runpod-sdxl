import type { ChainConfig } from "../config";
import { measureClipping, type ClippingResult } from "../measure/clipping";

export type ClippingCheckParams = ChainConfig["stages"]["clippingCheck"]["params"];

export function runClippingCheck(x: Float32Array, sampleRate: number, p: ClippingCheckParams): { result: ClippingResult; clipped: boolean } {
  const result = measureClipping({ sampleRate, channels: [x] }, p.detect);
  return { result, clipped: result.runCount.value >= p.detect.minRunsToFire };
}
