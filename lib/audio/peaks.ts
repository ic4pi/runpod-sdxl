/** Min/max per column for waveform drawing. Columns span `totalSec` on a shared time axis, so signals of different lengths align. */
export interface Peaks {
  min: Float32Array;
  max: Float32Array;
}

export function computePeaks(x: Float32Array, sampleRate: number, columns: number, totalSec: number, gain = 1): Peaks {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const perCol = (totalSec * sampleRate) / columns;
  for (let c = 0; c < columns; c++) {
    const a = Math.floor(c * perCol);
    const b = Math.min(x.length, Math.floor((c + 1) * perCol));
    let lo = 0;
    let hi = 0;
    for (let i = a; i < b; i++) {
      const v = x[i]! * gain;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max };
}
