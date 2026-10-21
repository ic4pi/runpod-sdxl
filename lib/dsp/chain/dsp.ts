/** Small shared helpers for chain stages. Math identities only; every tuning number comes from config. */
export const db2lin = (db: number): number => Math.pow(10, db / 20);
export const lin2dbSafe = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));
export const pow2dbSafe = (x: number): number => 10 * Math.log10(Math.max(x, 1e-24));

/** One-pole smoothing coefficient for a time constant in ms (time to ~63%). 0 ms -> instant. */
export function smoothCoef(ms: number, sampleRate: number): number {
  return ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sampleRate));
}

export const msToSamples = (ms: number, sampleRate: number): number => Math.round((ms / 1000) * sampleRate);
