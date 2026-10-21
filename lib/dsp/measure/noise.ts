import { type Pcm, type Quantity, MeasurementError, assertPcm, durationSec, pow2db, q } from "./types";
import { DEFAULT_THRESHOLDS, type MeasureThresholds } from "./thresholds";

export interface NoiseResult {
  /** RMS of the supplied print with its DC removed. */
  noiseFloor: Quantity<"dBFS">;
  /** Power-subtracted speech RMS over blocks well above the floor. */
  speechLevel: Quantity<"dBFS">;
  snr: Quantity<"dB">;
  printDuration: Quantity<"s">;
  speechSeconds: Quantity<"s">;
}

const BLOCK_SEC = 0.1;

function monoMix(pcm: Pcm): Float64Array {
  const n = pcm.channels[0]!.length;
  const out = new Float64Array(n);
  for (const ch of pcm.channels) for (let i = 0; i < n; i++) out[i] = out[i]! + ch[i]! / pcm.channels.length;
  return out;
}

function blockMeanSquares(x: Float64Array, block: number, mean: number): Float64Array {
  const nb = Math.floor(x.length / block);
  const out = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let i = b * block, end = i + block; i < end; i++) {
      const v = x[i]! - mean;
      s += v * v;
    }
    out[b] = s / block;
  }
  return out;
}

const meanOf = (x: Float64Array): number => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]!;
  return s / x.length;
};

/**
 * Noise floor and SNR from a user-supplied noise print (silence of the room, same mic, same session).
 * Throws on a print that is too short/long, has a different sample rate, or is not stationary (contains speech/bumps).
 */
export function measureNoise(
  pcm: Pcm,
  print: Pcm | null | undefined,
  th: MeasureThresholds["noise"] = DEFAULT_THRESHOLDS.noise,
): NoiseResult {
  if (!print) throw new MeasurementError("NO_NOISE_PRINT", "A 2-3 s noise print is required for noise floor / SNR.");
  assertPcm(pcm);
  assertPcm(print);
  if (print.sampleRate !== pcm.sampleRate) {
    throw new MeasurementError("NOISE_PRINT_INVALID", "Noise print sample rate differs from the audio.");
  }
  const printSec = durationSec(print);
  if (printSec < th.minPrintSec || printSec > th.maxPrintSec) {
    throw new MeasurementError(
      "NOISE_PRINT_INVALID",
      `Noise print is ${printSec.toFixed(2)} s; allowed ${th.minPrintSec}-${th.maxPrintSec} s.`,
    );
  }
  const block = Math.round(BLOCK_SEC * pcm.sampleRate);
  const pm = monoMix(print);
  const pMean = meanOf(pm);
  const pBlocks = blockMeanSquares(pm, block, pMean);
  let pMin = Infinity;
  let pMax = 0;
  let pSum = 0;
  for (const ms of pBlocks) {
    pMin = Math.min(pMin, ms);
    pMax = Math.max(pMax, ms);
    pSum += ms;
  }
  if (pMax === 0) throw new MeasurementError("NOISE_PRINT_INVALID", "Noise print is digital silence.");
  const spread = pow2db(pMax) - pow2db(pMin);
  if (spread > th.maxPrintSpreadDb) {
    throw new MeasurementError(
      "NOISE_PRINT_INVALID",
      `Noise print is not stationary (${spread.toFixed(1)} dB block spread > ${th.maxPrintSpreadDb} dB). It likely contains speech or a bump.`,
    );
  }
  const noiseMs = pSum / pBlocks.length;

  const sm = monoMix(pcm);
  const sBlocks = blockMeanSquares(sm, block, meanOf(sm));
  const gate = noiseMs * Math.pow(10, th.speechOverNoiseDb / 10);
  let active = 0;
  let activeSum = 0;
  for (const ms of sBlocks) {
    if (ms >= gate) {
      active++;
      activeSum += ms;
    }
  }
  const activeSec = active * BLOCK_SEC;
  if (activeSec < th.minActiveSec) {
    throw new MeasurementError(
      "NO_SPEECH_ABOVE_NOISE",
      `Only ${activeSec.toFixed(2)} s of audio is >= ${th.speechOverNoiseDb} dB above the noise print.`,
    );
  }
  const speechMs = activeSum / active - noiseMs;
  if (speechMs <= 0) throw new MeasurementError("NO_SPEECH_ABOVE_NOISE", "Speech power does not exceed noise power.");
  return {
    noiseFloor: q(pow2db(noiseMs), "dBFS"),
    speechLevel: q(pow2db(speechMs), "dBFS"),
    snr: q(pow2db(speechMs / noiseMs), "dB"),
    printDuration: q(printSec, "s"),
    speechSeconds: q(activeSec, "s"),
  };
}

