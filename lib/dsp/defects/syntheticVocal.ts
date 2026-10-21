import type { Pcm } from "../measure/types";
import { makeRng } from "./rng";

/**
 * DEV-ONLY. Generates a rap-like clean vocal: 2.5 s of room tone (usable as the noise print),
 * then syllables of formant-shaped voiced sound (additive harmonics, gliding F0) with
 * occasional fricative noise, ending with room tone. Peak is -6 dBFS, room tone about -60 dBFS RMS.
 * No energy below the lowest F0 (>= ~100 Hz) and zero DC, so it is a clean control for
 * clipping, hum, plosive and DC detectors.
 */
export interface SyntheticVocalOptions {
  seed: number;
  /** Centre of the F0 range, Hz. */
  f0Base: number;
  durationSec?: number;
  sampleRate?: number;
  noisePrintSec?: number;
}

export const NOISE_PRINT_SEC = 2.5;

const VOWELS: readonly (readonly [number, number, number])[] = [
  [730, 1090, 2440], // a
  [530, 1840, 2480], // e
  [270, 2290, 3010], // i
  [570, 840, 2410], // o
  [300, 870, 2240], // u
];

export function generateSyntheticVocal(opts: SyntheticVocalOptions): Pcm {
  const sr = opts.sampleRate ?? 48000;
  const dur = opts.durationSec ?? 14;
  const printSec = opts.noisePrintSec ?? NOISE_PRINT_SEC;
  const n = Math.round(dur * sr);
  const rng = makeRng(opts.seed);
  const voice = new Float64Array(n);

  let t = printSec + 0.4;
  let phase = 0;
  while (t < dur - 0.6) {
    const len = 0.12 + rng() * 0.16;
    const start = Math.round(t * sr);
    const end = Math.min(n, start + Math.round(len * sr));
    if (rng() < 0.15) {
      // fricative: differenced white noise (high-frequency emphasis)
      let prev = 0;
      for (let i = start; i < end; i++) {
        const x = rng() * 2 - 1;
        const env = Math.sin((Math.PI * (i - start)) / (end - start));
        voice[i] = voice[i]! + (x - prev) * 0.12 * env;
        prev = x;
      }
    } else {
      const f0a = opts.f0Base * (0.85 + rng() * 0.3);
      const f0b = f0a * (0.88 + rng() * 0.24);
      const [f1, f2, f3] = VOWELS[Math.floor(rng() * VOWELS.length)]!;
      const attack = Math.round(0.015 * sr);
      const release = Math.round(0.04 * sr);
      const gains = new Float64Array(64);
      let gainsAt = -1;
      for (let i = start; i < end; i++) {
        const u = (i - start) / (end - start);
        const f0 = f0a + (f0b - f0a) * u + 3 * Math.sin(2 * Math.PI * 5.5 * (i / sr));
        phase += (2 * Math.PI * f0) / sr;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        if (i - gainsAt >= 64) {
          gainsAt = i;
          for (let h = 1; h < 64; h++) {
            const f = h * f0;
            gains[h] =
              f > 5000
                ? 0
                : (1 / h) *
                  (1 / (1 + ((f - f1) / 90) ** 2) + 0.7 / (1 + ((f - f2) / 130) ** 2) + 0.4 / (1 + ((f - f3) / 180) ** 2));
          }
        }
        let s = 0;
        for (let h = 1; h < 64; h++) {
          if (gains[h] === 0) break;
          s += gains[h]! * Math.sin(h * phase);
        }
        const env = Math.min(1, (i - start) / attack, (end - i) / release);
        voice[i] = voice[i]! + s * env;
      }
    }
    t += len + 0.04 + rng() * 0.08;
  }

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(voice[i]!));
  const speechScale = Math.pow(10, -6 / 20) / peak;

  // Room tone: white noise through a one-pole low-pass, about -60 dBFS RMS.
  const tone = new Float64Array(n);
  let lp = 0;
  let toneSq = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.35 * ((rng() * 2 - 1) - lp);
    tone[i] = lp;
    toneSq += lp * lp;
  }
  const toneScale = Math.pow(10, -60 / 20) / Math.sqrt(toneSq / n);

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = voice[i]! * speechScale + tone[i]! * toneScale;
  return { sampleRate: sr, channels: [out] };
}
