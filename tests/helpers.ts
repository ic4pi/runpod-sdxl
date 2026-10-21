import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CHAIN_CONFIG, type ChainConfig } from "../lib/dsp/config";
import { cloneConfig } from "../lib/dsp/configUtil";
import { createRnnoiseEngine, type RnnoiseEngine } from "../lib/dsp/chain/rnnoise";
import { makeRng } from "../lib/dsp/rng";

export const SR = 48000;
export const cfgCopy = (): ChainConfig => cloneConfig(DEFAULT_CHAIN_CONFIG);

export const sine = (hz: number, amp: number, sec: number, sr = SR, phase = 0): Float32Array => {
  const x = new Float32Array(Math.round(sec * sr));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr + phase);
  return x;
};

/** Seeded white noise with the given RMS (linear). Gaussian-ish (sum of 12 uniforms). */
export const noise = (rms: number, sec: number, seed: number, sr = SR): Float32Array => {
  const r = makeRng(seed);
  const x = new Float32Array(Math.round(sec * sr));
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let k = 0; k < 12; k++) s += r();
    x[i] = (s - 6) * rms;
  }
  return x;
};

export const rmsOf = (x: ArrayLike<number>, a = 0, b = x.length): number => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (b - a));
};
export const dbOf = (x: number): number => 20 * Math.log10(x);

/** Amplitude of a single frequency in x[a..b) via quadrature correlation. */
export function toneAmp(x: ArrayLike<number>, hz: number, a = 0, b = x.length, sr = SR): number {
  let c = 0;
  let s = 0;
  for (let i = a; i < b; i++) {
    const w = (2 * Math.PI * hz * i) / sr;
    c += x[i]! * Math.cos(w);
    s += x[i]! * Math.sin(w);
  }
  return (2 * Math.sqrt(c * c + s * s)) / (b - a);
}

let engine: Promise<RnnoiseEngine> | null = null;
export function loadEngine(): Promise<RnnoiseEngine> {
  engine ??= createRnnoiseEngine(
    readFileSync(path.join(__dirname, "..", "public", "wasm", "rnnoise.wasm")),
    DEFAULT_CHAIN_CONFIG.stages.noiseReduction.params.rnnoise,
  );
  return engine;
}

export const clipAsym = (x: Float32Array, pos: number, neg: number, gainDb: number): Float32Array => {
  const g = Math.pow(10, gainDb / 20);
  return x.map((v) => Math.max(-neg, Math.min(pos, v * g)));
};
