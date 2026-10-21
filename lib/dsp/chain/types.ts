import type { StageId } from "../config";
import type { ClippingResult } from "../measure/clipping";

export type StageStatus = "applied" | "bypassed" | "skipped" | "awaiting-confirmation" | "analysis";

export interface StageReport {
  id: StageId;
  status: StageStatus;
  /** Human-readable reason (why skipped, what was done). */
  note?: string;
  metrics?: Record<string, number | string | boolean>;
}

/** A detected pop. All fields are measured numbers; nothing here is a guess. */
export interface PlosiveCandidate {
  id: number;
  startSec: number;
  durationMs: number;
  lfPeakDbfs: number;
  lfFractionDb: number;
  /** LF level rise at onset over the preceding window. */
  onsetRiseDb: number;
  /** LF peak level over the file's median LF level. */
  overMedianDb: number;
}

/**
 * Only constructible through `confirmPlosives`. De-plosive's apply step takes this type, so it
 * cannot run on unconfirmed detections.
 */
export interface ConfirmedPlosives {
  readonly kind: "confirmed-plosives";
  readonly events: readonly PlosiveCandidate[];
}

export function confirmPlosives(candidates: readonly PlosiveCandidate[], confirmedIds: Iterable<number>): ConfirmedPlosives {
  const ids = new Set(confirmedIds);
  return { kind: "confirmed-plosives", events: candidates.filter((c) => ids.has(c.id)) };
}

export type PrintLayer = "length" | "energy" | "bump" | "vad" | "harmonic" | "silence";

export interface PrintRejection {
  layer: PrintLayer;
  message: string;
  value: number;
  limit: number;
}

export interface NoisePrintVerdict {
  ok: boolean;
  rejections: PrintRejection[];
  /** RMS of the print with DC removed, dBFS. Null when the print is unusable. */
  noiseFloorDbfs: number | null;
  /** Per-layer measured values, for display. */
  metrics: {
    durationSec: number;
    blockSpreadDb: number | null;
    bumpOverMedianDb: number | null;
    vadSpeechFraction: number | null;
    voicedFraction: number | null;
  };
}

export interface ChainAnalysis {
  sampleRate: number;
  /** Mono, internal-rate copy of the source. The source AudioBuffer itself is never touched. */
  prepared: Float32Array;
  clipping: ClippingResult | null;
  clipped: boolean;
  noisePrint: { startSec: number; lengthSec: number; verdict: NoisePrintVerdict } | null;
  plosiveCandidates: PlosiveCandidate[];
}
