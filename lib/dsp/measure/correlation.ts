import { type Pcm, type Quantity, MeasurementError, assertPcm, pow2db, q } from "./types";

export interface CorrelationResult {
  /** Phase-correlation-meter coefficient, -1..+1 (sum(LR)/sqrt(sum(LL)*sum(RR))). */
  correlation: Quantity<"coefficient">;
  /** Level of the (L+R)/2 sum relative to the mean L/R level. 0 dB = fully mono-safe. */
  monoSumLoss: Quantity<"dB">;
}

/** Stereo only. Throws NOT_STEREO for mono input; a mono file has no correlation to report. */
export function measureCorrelation(pcm: Pcm): CorrelationResult {
  assertPcm(pcm);
  if (pcm.channels.length < 2) {
    throw new MeasurementError("NOT_STEREO", "Correlation needs 2 channels; input is mono.");
  }
  const l = pcm.channels[0]!;
  const r = pcm.channels[1]!;
  let ll = 0;
  let rr = 0;
  let lr = 0;
  let mm = 0;
  for (let i = 0; i < l.length; i++) {
    const a = l[i]!;
    const b = r[i]!;
    ll += a * a;
    rr += b * b;
    lr += a * b;
    const m = (a + b) / 2;
    mm += m * m;
  }
  if (ll === 0 || rr === 0) {
    throw new MeasurementError("SILENT_INPUT", "A channel is silent; correlation undefined.");
  }
  const n = l.length;
  const avg = (ll + rr) / 2 / n;
  return {
    correlation: q(lr / Math.sqrt(ll * rr), "coefficient"),
    monoSumLoss: q(pow2db(mm / n / avg), "dB"),
  };
}
