/** Direct-form-I biquad coefficients, a0 normalised to 1. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function applyBiquad(x: ArrayLike<number>, c: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = yi;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
  }
  return y;
}

/** RBJ cookbook 2nd-order low-pass. */
export function lowpass(fc: number, q: number, sr: number): Biquad {
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cs = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cs) / 2 / a0,
    b1: (1 - cs) / a0,
    b2: (1 - cs) / 2 / a0,
    a1: (-2 * cs) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ cookbook 2nd-order high-pass. */
export function highpass(fc: number, q: number, sr: number): Biquad {
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cs = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cs) / 2 / a0,
    b1: -(1 + cs) / a0,
    b2: (1 + cs) / 2 / a0,
    a1: (-2 * cs) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Q values for a 4th-order Butterworth as two cascaded biquads. */
export const BUTTERWORTH4_Q = [0.5411961, 1.3065630] as const;
export const BUTTERWORTH2_Q = Math.SQRT1_2;
