import { applyBiquad, BUTTERWORTH2_Q, BUTTERWORTH4_Q, highpass, lowpass } from "./biquad";
import { type Pcm, type Quantity, MeasurementError, assertPcm, percentile, pow2db, q } from "./types";
import { DEFAULT_THRESHOLDS, type MeasureThresholds } from "./thresholds";

export interface PlosiveEvent {
  startSec: number;
  durationMs: number;
  lfPeak: Quantity<"dBFS">;
  lfFraction: Quantity<"dB">;
}

export interface PlosiveResult {
  eventCount: Quantity<"events">;
  events: PlosiveEvent[];
  /** Median LF-band frame level used as the burst baseline. */
  lfMedian: Quantity<"dBFS">;
}

const FRAME_SEC = 0.01;

export interface LfFrames {
  frameSec: number;
  /** Mean-square of the LF band per frame (channel-averaged). */
  lf: Float64Array;
  /** Mean-square of the 20 Hz-high-passed full band per frame. */
  total: Float64Array;
}

/** Per-frame LF-band and full-band energy. Shared by the Phase 1 measurement and the Phase 2 de-plosive detector. */
export function computeLfFrames(
  pcm: Pcm,
  th: Pick<MeasureThresholds["plosive"], "lfLowHz" | "lfHighHz">,
  frameSec: number = FRAME_SEC,
): LfFrames {
  const sr = pcm.sampleRate;
  const frame = Math.round(frameSec * sr);
  const nFrames = Math.floor(pcm.channels[0]!.length / frame);
  const lf = new Float64Array(nFrames);
  const total = new Float64Array(nFrames);
  for (const ch of pcm.channels) {
    const hp = applyBiquad(ch, highpass(th.lfLowHz, BUTTERWORTH2_Q, sr));
    let band = hp;
    for (const Q of BUTTERWORTH4_Q) band = applyBiquad(band, lowpass(th.lfHighHz, Q, sr));
    for (let f = 0; f < nFrames; f++) {
      let a = 0;
      let b = 0;
      for (let i = f * frame, end = i + frame; i < end; i++) {
        a += band[i]! * band[i]!;
        b += hp[i]! * hp[i]!;
      }
      lf[f] = lf[f]! + a / frame / pcm.channels.length;
      total[f] = total[f]! + b / frame / pcm.channels.length;
    }
  }
  return { frameSec, lf, total };
}

/**
 * Low-frequency pop bursts. Per 10 ms frame: LF-band level (20-80 Hz default), LF share of
 * the full-band energy, and LF level relative to the file's median LF level. A frame is
 * plosive-like when all three exceed thresholds; consecutive frames merge into one event
 * and events outside the min/max duration are dropped (sustained bass is not a plosive).
 */
export function measurePlosives(pcm: Pcm, th: MeasureThresholds["plosive"] = DEFAULT_THRESHOLDS.plosive): PlosiveResult {
  assertPcm(pcm);
  const sr = pcm.sampleRate;
  const frame = Math.round(FRAME_SEC * sr);
  const nFrames = Math.floor(pcm.channels[0]!.length / frame);
  if (nFrames < 100) throw new MeasurementError("TOO_SHORT", "Plosive analysis needs >= 1 s of audio.");

  const { lf, total } = computeLfFrames(pcm, th);

  const settle = Math.ceil(th.settleSec / FRAME_SEC);
  const lfDb = Array.from(lf, pow2db);
  const medianDb = percentile(lfDb.slice(settle), 0.5);
  const minFrames = Math.ceil(th.minDurationMs / 1000 / FRAME_SEC);
  const maxFrames = Math.floor(th.maxDurationMs / 1000 / FRAME_SEC);

  const events: PlosiveEvent[] = [];
  let start = -1;
  let peakDb = -Infinity;
  let fracAtPeak = 0;
  const close = (end: number) => {
    const n = end - start;
    if (start >= 0 && n >= minFrames && n <= maxFrames) {
      events.push({
        startSec: start * FRAME_SEC,
        durationMs: n * FRAME_SEC * 1000,
        lfPeak: q(peakDb, "dBFS"),
        lfFraction: q(fracAtPeak, "dB"),
      });
    }
    start = -1;
    peakDb = -Infinity;
  };
  for (let f = settle; f < nFrames; f++) {
    const frac = pow2db(lf[f]! / Math.max(total[f]!, 1e-30));
    const hit = lfDb[f]! >= th.minLfDbfs && frac >= th.minLfFractionDb && lfDb[f]! >= medianDb + th.burstOverMedianDb;
    if (hit) {
      if (start < 0) start = f;
      if (lfDb[f]! > peakDb) {
        peakDb = lfDb[f]!;
        fracAtPeak = frac;
      }
    } else if (start >= 0) {
      close(f);
    }
  }
  if (start >= 0) close(nFrames);
  return { eventCount: q(events.length, "events"), events, lfMedian: q(medianDb, "dBFS") };
}
