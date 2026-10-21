import type { Pcm } from "../measure/types";
import type { DetectorId } from "../measure/detectors";
import { makeRng } from "./rng";
import { clonePcm, findOnsets } from "./util";

/** DEV-ONLY defect injectors. Pure: each returns a new Pcm and never mutates its input. */
export type Severity = "mild" | "moderate" | "severe";
export const SEVERITIES: readonly Severity[] = ["mild", "moderate", "severe"];

export type DefectId = "clipping" | "hum_60hz" | "plosives" | "dc_offset";

export interface DefectSpec {
  id: DefectId;
  label: string;
  /** The one detector that is supposed to fire on this defect. */
  target: DetectorId;
  inject: (pcm: Pcm, severity: Severity, seed: number) => Pcm;
  /** Human-readable parameter per severity, for the report. */
  describe: Record<Severity, string>;
}

const CLIP_CEILING = 0.95;
const CLIP_DEPTH_DB: Record<Severity, number> = { mild: 2, moderate: 4, severe: 8 };

function injectClipping(pcm: Pcm, severity: Severity): Pcm {
  const out = clonePcm(pcm);
  let peak = 0;
  for (const ch of out.channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]!));
  const gain = (CLIP_CEILING / peak) * Math.pow(10, CLIP_DEPTH_DB[severity] / 20);
  for (const ch of out.channels) {
    for (let i = 0; i < ch.length; i++) ch[i] = Math.max(-CLIP_CEILING, Math.min(CLIP_CEILING, ch[i]! * gain));
  }
  return out;
}

const HUM_DBFS: Record<Severity, number> = { mild: -68, moderate: -58, severe: -45 };
const HUM_HARMONIC_DB = [0, -6, -10, -14];

function injectHum(pcm: Pcm, severity: Severity, seed: number): Pcm {
  const out = clonePcm(pcm);
  const rng = makeRng(seed ^ 0x60);
  const phases = HUM_HARMONIC_DB.map(() => rng() * 2 * Math.PI);
  for (const ch of out.channels) {
    for (let h = 0; h < HUM_HARMONIC_DB.length; h++) {
      const amp = Math.SQRT2 * Math.pow(10, (HUM_DBFS[severity] + HUM_HARMONIC_DB[h]!) / 20);
      const w = (2 * Math.PI * 60 * (h + 1)) / out.sampleRate;
      for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! + amp * Math.sin(w * i + phases[h]!);
    }
  }
  return out;
}

const PLOSIVE_PEAK: Record<Severity, number> = { mild: 0.12, moderate: 0.25, severe: 0.5 };
const PLOSIVE_COUNT = 6;

/** Low-passed noise burst (about 20-80 Hz) with 3 ms attack and ~35 ms decay, placed just before vowel onsets. */
function injectPlosives(pcm: Pcm, severity: Severity, seed: number): Pcm {
  const out = clonePcm(pcm);
  const sr = out.sampleRate;
  const rng = makeRng(seed ^ 0x9050);
  const onsets = findOnsets(out, 3).slice(0, PLOSIVE_COUNT);
  const len = Math.round(0.18 * sr);
  for (const ch of out.channels) {
    for (const t of onsets) {
      const at = Math.max(0, Math.round((t - 0.015) * sr));
      // two-pole low-pass noise via cascaded one-poles at ~60 Hz
      const a = 1 - Math.exp((-2 * Math.PI * 60) / sr);
      let l1 = 0;
      let l2 = 0;
      const burst = new Float64Array(len);
      let bp = 0;
      for (let i = 0; i < len; i++) {
        l1 += a * (rng() * 2 - 1 - l1);
        l2 += a * (l1 - l2);
        const env = Math.min(1, i / (0.003 * sr)) * Math.exp(-i / (0.035 * sr));
        burst[i] = l2 * env;
        bp = Math.max(bp, Math.abs(burst[i]!));
      }
      const scale = PLOSIVE_PEAK[severity] / bp;
      for (let i = 0; i < len && at + i < ch.length; i++) ch[at + i] = ch[at + i]! + burst[i]! * scale;
    }
  }
  return out;
}

const DC_OFFSET: Record<Severity, number> = { mild: 0.008, moderate: 0.02, severe: 0.05 };

function injectDc(pcm: Pcm, severity: Severity): Pcm {
  const out = clonePcm(pcm);
  for (const ch of out.channels) for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! + DC_OFFSET[severity];
  return out;
}

export const DEFECTS: readonly DefectSpec[] = [
  {
    id: "clipping",
    label: "Clipping",
    target: "clipping",
    inject: injectClipping,
    describe: {
      mild: `peaks ${CLIP_DEPTH_DB.mild} dB over a ${CLIP_CEILING} FS ceiling, hard-clipped`,
      moderate: `peaks ${CLIP_DEPTH_DB.moderate} dB over ceiling`,
      severe: `peaks ${CLIP_DEPTH_DB.severe} dB over ceiling`,
    },
  },
  {
    id: "hum_60hz",
    label: "60 Hz hum",
    target: "hum",
    inject: injectHum,
    describe: {
      mild: `60 Hz at ${HUM_DBFS.mild} dBFS RMS + harmonics (-6/-10/-14 dB)`,
      moderate: `60 Hz at ${HUM_DBFS.moderate} dBFS RMS + harmonics`,
      severe: `60 Hz at ${HUM_DBFS.severe} dBFS RMS + harmonics`,
    },
  },
  {
    id: "plosives",
    label: "Plosives",
    target: "plosive",
    inject: injectPlosives,
    describe: {
      mild: `${PLOSIVE_COUNT} LF pops, peak ${PLOSIVE_PEAK.mild} FS`,
      moderate: `${PLOSIVE_COUNT} LF pops, peak ${PLOSIVE_PEAK.moderate} FS`,
      severe: `${PLOSIVE_COUNT} LF pops, peak ${PLOSIVE_PEAK.severe} FS`,
    },
  },
  {
    id: "dc_offset",
    label: "DC offset",
    target: "dc_offset",
    inject: injectDc,
    describe: {
      mild: `+${DC_OFFSET.mild} FS`,
      moderate: `+${DC_OFFSET.moderate} FS`,
      severe: `+${DC_OFFSET.severe} FS`,
    },
  },
];
