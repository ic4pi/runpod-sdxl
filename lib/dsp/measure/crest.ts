import { type Pcm, type Quantity, MeasurementError, assertPcm, lin2db, q } from "./types";
import { DEFAULT_THRESHOLDS, type MeasureThresholds } from "./thresholds";

export interface CrestResult {
  /** Sample peak / whole-file RMS. */
  crest: Quantity<"dB">;
  /** Same, restricted to 100 ms blocks above the activity floor. */
  activeCrest: Quantity<"dB">;
  peak: Quantity<"dBFS">;
  rms: Quantity<"dBFS">;
  activeRms: Quantity<"dBFS">;
  activeFraction: Quantity<"fraction">;
}

export function measureCrest(pcm: Pcm, th: MeasureThresholds["crest"] = DEFAULT_THRESHOLDS.crest): CrestResult {
  assertPcm(pcm);
  const block = Math.round(0.1 * pcm.sampleRate);
  const len = pcm.channels[0]!.length;
  const nBlocks = Math.floor(len / block);
  const nCh = pcm.channels.length;
  let peak = 0;
  let sumSq = 0;
  let activeSumSq = 0;
  let activePeak = 0;
  let activeBlocks = 0;
  const floorMs = Math.pow(10, th.activeBlockFloorDbfs / 10);
  for (let b = 0; b < nBlocks; b++) {
    let bs = 0;
    let bp = 0;
    for (const ch of pcm.channels) {
      for (let i = b * block, end = i + block; i < end; i++) {
        const v = ch[i]!;
        bs += v * v;
        const a = Math.abs(v);
        if (a > bp) bp = a;
      }
    }
    const ms = bs / (block * nCh);
    sumSq += bs;
    if (bp > peak) peak = bp;
    if (ms >= floorMs) {
      activeSumSq += bs;
      activeBlocks++;
      if (bp > activePeak) activePeak = bp;
    }
  }
  if (peak === 0) throw new MeasurementError("SILENT_INPUT", "All samples are zero; crest factor undefined.");
  if (activeBlocks === 0) {
    throw new MeasurementError("INSUFFICIENT_DATA", `No 100 ms block above ${th.activeBlockFloorDbfs} dBFS.`);
  }
  const rms = Math.sqrt(sumSq / (nBlocks * block * nCh));
  const activeRms = Math.sqrt(activeSumSq / (activeBlocks * block * nCh));
  return {
    crest: q(lin2db(peak / rms), "dB"),
    activeCrest: q(lin2db(activePeak / activeRms), "dB"),
    peak: q(lin2db(peak), "dBFS"),
    rms: q(lin2db(rms), "dBFS"),
    activeRms: q(lin2db(activeRms), "dBFS"),
    activeFraction: q(activeBlocks / nBlocks, "fraction"),
  };
}
