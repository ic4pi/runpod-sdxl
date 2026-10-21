import { MeasurementError } from "./types";

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number) {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

/** In-place radix-2 complex FFT. n must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2 || (n & (n - 1)) !== 0 || im.length !== n) {
    throw new MeasurementError("INTERNAL", `FFT size must be a power of two, got ${n}.`);
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, tw = 0; k < half; k++, tw += step) {
        const wr = cos[tw]!;
        const wi = sin[tw]!;
        const a = i + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

/** Periodic Hann window. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Welch-style framing. Calls `onFrame` with the one-sided mean-square spectrum
 * (index k = bin k, k in 0..n/2) of each full frame of `x`, scaled so the sum
 * over bins equals the frame's windowed mean-square (a full-scale sine -> 0.5).
 * Channels are averaged in the power domain by the caller.
 */
export function forEachPowerSpectrum(
  x: Float32Array,
  n: number,
  hop: number,
  onFrame: (ms: Float64Array, frameIndex: number) => void,
): number {
  const w = hann(n);
  let sumW2 = 0;
  for (let i = 0; i < n; i++) sumW2 += w[i]! * w[i]!;
  const scale = 1 / (n * sumW2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const ms = new Float64Array(n / 2 + 1);
  let frames = 0;
  for (let start = 0; start + n <= x.length; start += hop, frames++) {
    for (let i = 0; i < n; i++) {
      re[i] = x[start + i]! * w[i]!;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k <= n / 2; k++) {
      const p = (re[k]! * re[k]! + im[k]! * im[k]!) * scale;
      ms[k] = k === 0 || k === n / 2 ? p : 2 * p;
    }
    onFrame(ms, frames);
  }
  return frames;
}
