import type { Pcm } from "../measure/types";

export const clonePcm = (p: Pcm): Pcm => ({ sampleRate: p.sampleRate, channels: p.channels.map((c) => c.slice()) });

export function slicePcm(p: Pcm, startSec: number, lengthSec: number): Pcm {
  const a = Math.round(startSec * p.sampleRate);
  const b = a + Math.round(lengthSec * p.sampleRate);
  return { sampleRate: p.sampleRate, channels: p.channels.map((c) => c.slice(a, b)) };
}

/** Quietest `lengthSec` window (by mean-square on channel 0, 100 ms resolution). Dev convenience for uploaded files. */
export function quietestWindow(p: Pcm, lengthSec: number): Pcm {
  const hop = Math.round(0.1 * p.sampleRate);
  const win = Math.round(lengthSec * p.sampleRate);
  const x = p.channels[0]!;
  if (x.length < win) throw new Error(`Audio shorter than ${lengthSec}s; cannot take a noise print.`);
  const nb = Math.floor(x.length / hop);
  const ms = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let i = b * hop; i < (b + 1) * hop; i++) s += x[i]! * x[i]!;
    ms[b] = s / hop;
  }
  const wb = Math.round(win / hop);
  let best = 0;
  let bestSum = Infinity;
  for (let b = 0; b + wb <= nb; b++) {
    let s = 0;
    for (let k = 0; k < wb; k++) s += ms[b + k]!;
    if (s < bestSum) {
      bestSum = s;
      best = b;
    }
  }
  return slicePcm(p, (best * hop) / p.sampleRate, lengthSec);
}

/** Onsets: 10 ms-RMS frames that rise >= 15 dB over the previous 60 ms and exceed -40 dBFS. Min spacing 0.5 s. */
export function findOnsets(p: Pcm, afterSec: number): number[] {
  const hop = Math.round(0.01 * p.sampleRate);
  const x = p.channels[0]!;
  const nb = Math.floor(x.length / hop);
  const db = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let i = b * hop; i < (b + 1) * hop; i++) s += x[i]! * x[i]!;
    db[b] = 10 * Math.log10(s / hop + 1e-20);
  }
  const out: number[] = [];
  let last = -Infinity;
  for (let b = Math.ceil(afterSec / 0.01) + 6; b < nb - 10; b++) {
    let prev = 0;
    for (let k = 1; k <= 6; k++) prev += db[b - k]! / 6;
    const t = b * 0.01;
    if (db[b + 2]! > -40 && db[b + 2]! - prev > 15 && t - last >= 0.5) {
      out.push(t);
      last = t;
    }
  }
  return out;
}
