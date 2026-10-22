import type { ChainConfig } from "../dsp/config";
import { applyLimiter } from "../dsp/chain/limiter";
import { db2lin } from "../dsp/chain/dsp";
import { measureLoudness } from "../dsp/measure/loudness";
import { measureTruePeak } from "../dsp/measure/truePeak";

export type MasterStatus =
  | "met"                  // within tolerance of the loudness target, ceiling held
  | "ceiling-limited"      // target not reachable without breaking the true-peak ceiling / the limiter cap: delivered quieter than target
  | "too-short-to-measure"; // under the integrated-loudness minimum: limiter only

export interface MasterReport {
  status: MasterStatus;
  targetLufs: number;
  /** Integrated loudness of the processed buffer before export gain. Null when it could not be measured. */
  inputLufs: number | null;
  /** Integrated loudness of what is delivered. Null when it could not be measured. */
  outputLufs: number | null;
  /** Total gain applied before the final limiter pass. */
  gainDb: number;
  /** True peak of what is delivered (4x oversampled). */
  outputTruePeakDbtp: number;
  /** Ceiling the final limiter pass enforced (config ceiling minus any format margin). */
  ceilingDbtp: number;
  limiterMaxReductionDb: number;
  iterations: number;
  note: string;
}

export interface MasterResult {
  pcm: Float32Array;
  sampleRate: number;
  report: MasterReport;
}

interface Candidate {
  gainDb: number;
  out: Float32Array;
  lufs: number;
  reductionDb: number;
}

const scale = (x: Float32Array, db: number): Float32Array => {
  const g = db2lin(db);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]! * g;
  return out;
};

/**
 * Export mastering. ORDER IS LOAD-BEARING: measure integrated LUFS on the processed buffer -> apply gain ->
 * RE-RUN the limiter at the ceiling -> re-measure. The limiter always runs last (even if the user bypassed the
 * limiter stage), so the ceiling holds in the delivered file whatever the gain.
 *
 * The limiter lowers peaks, which lowers loudness, so a single gain step can land below target on dynamic material.
 * We iterate on the measured result (secant on the shortfall). The true-peak ceiling and the limiter-reduction cap
 * always win over the loudness target: if the target needs more limiting than `maxLimiterReductionDb`, we deliver the
 * loudest candidate that stays within the cap and say so (`ceiling-limited`).
 */
export function masterForExport(
  x: Float32Array,
  sampleRate: number,
  cfg: ChainConfig,
  opts: { ceilingMarginDb?: number } = {},
): MasterResult {
  const ex = cfg.export;
  const ceilingDbtp = cfg.stages.limiter.params.ceilingDbtp - (opts.ceilingMarginDb ?? 0);
  const limiter = { ...cfg.stages.limiter.params, ceilingDbtp };
  const limit = (y: Float32Array) => applyLimiter(y, sampleRate, limiter);
  const tpOf = (y: Float32Array) => measureTruePeak({ sampleRate, channels: [y] }).truePeak.value;

  if (x.length / sampleRate < ex.minSecondsForLoudness) {
    const r = limit(x);
    return {
      pcm: r.out,
      sampleRate,
      report: {
        status: "too-short-to-measure",
        targetLufs: ex.targetLufs,
        inputLufs: null,
        outputLufs: null,
        gainDb: 0,
        outputTruePeakDbtp: tpOf(r.out),
        ceilingDbtp,
        limiterMaxReductionDb: r.maxReductionDb,
        iterations: 0,
        note: `Clip is shorter than ${ex.minSecondsForLoudness} s, so integrated loudness cannot be measured. No loudness target was applied; only the ${ceilingDbtp} dBTP limiter ran.`,
      },
    };
  }

  const inputLufs = measureLoudness({ sampleRate, channels: [x] }).integrated.value; // throws on silence: nothing to export
  const inputTp = tpOf(x);
  const safeGainDb = ceilingDbtp - inputTp; // largest gain that needs no limiting at all
  const wantedDb = ex.targetLufs - inputLufs;

  const finish = (c: Candidate, iterations: number, tag: "met" | "ceiling-limited", note: string): MasterResult => ({
    pcm: c.out,
    sampleRate,
    report: {
      status: tag,
      targetLufs: ex.targetLufs,
      inputLufs,
      outputLufs: c.lufs,
      gainDb: c.gainDb,
      outputTruePeakDbtp: tpOf(c.out),
      ceilingDbtp,
      limiterMaxReductionDb: c.reductionDb,
      iterations,
      note,
    },
  });

  const evaluate = (gainDb: number): Candidate => {
    const r = limit(scale(x, gainDb));
    return { gainDb, out: r.out, lufs: measureLoudness({ sampleRate, channels: [r.out] }).integrated.value, reductionDb: r.maxReductionDb };
  };

  // 1) Reachable without limiting (or attenuating): one pass, limiter is a safety net only.
  if (wantedDb <= safeGainDb + ex.loudnessToleranceLu) {
    const c = evaluate(wantedDb);
    return finish(c, 1, Math.abs(c.lufs - ex.targetLufs) <= ex.loudnessToleranceLu ? "met" : "ceiling-limited", `Gain ${c.gainDb.toFixed(1)} dB reaches the target without the limiter doing real work.`);
  }

  // 2) The target needs peaks pulled down. Start from the no-limiting gain (always valid) and search upward.
  let best: Candidate = evaluate(safeGainDb);
  let iterations = 1;
  let gain = wantedDb;
  let rejectedAt: number | null = null; // lowest gain whose limiter reduction exceeded the cap
  let prev: { gainDb: number; lufs: number } | null = null; // last valid point, for the slope of loudness vs gain
  while (iterations < ex.maxIterations) {
    const c = evaluate(gain);
    iterations++;
    const valid = c.reductionDb <= ex.maxLimiterReductionDb;
    if (valid) {
      if (Math.abs(c.lufs - ex.targetLufs) < Math.abs(best.lufs - ex.targetLufs) || best.reductionDb > ex.maxLimiterReductionDb) best = c;
      if (Math.abs(c.lufs - ex.targetLufs) <= ex.loudnessToleranceLu) {
        return finish(c, iterations, "met", `Reached the target with the limiter taking up to ${c.reductionDb.toFixed(1)} dB.`);
      }
      // Secant step: loudness rises more slowly than gain once the limiter works, so divide the shortfall by the measured slope.
      let slope = 1;
      if (prev && Math.abs(c.gainDb - prev.gainDb) > 1e-6) slope = Math.min(1, Math.max(ex.minLoudnessSlope, (c.lufs - prev.lufs) / (c.gainDb - prev.gainDb)));
      prev = { gainDb: c.gainDb, lufs: c.lufs };
      gain = c.gainDb + (ex.targetLufs - c.lufs) / slope;
      if (rejectedAt !== null && gain >= rejectedAt) gain = (best.gainDb + rejectedAt) / 2;
    } else {
      rejectedAt = rejectedAt === null ? gain : Math.min(rejectedAt, gain);
      gain = (best.gainDb + rejectedAt) / 2; // bisect back toward the last valid gain
    }
  }
  const c = best;
  const shortBy = ex.targetLufs - c.lufs;
  return finish(
    c,
    iterations,
    Math.abs(shortBy) <= ex.loudnessToleranceLu ? "met" : "ceiling-limited",
    Math.abs(shortBy) <= ex.loudnessToleranceLu
      ? `Reached the target within ${ex.loudnessToleranceLu} LU.`
      : `Target ${ex.targetLufs} LUFS not reachable without breaking the ${ceilingDbtp} dBTP ceiling or limiting more than ${ex.maxLimiterReductionDb} dB. Delivered at ${c.lufs.toFixed(1)} LUFS (${shortBy.toFixed(1)} LU short). The ceiling wins.`,
  );
}
