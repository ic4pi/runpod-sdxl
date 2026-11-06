import type { PresetId } from "../presets/types";

/**
 * Metrics that make sense on a FULL SONG. The stock reference profiles (lib/reference/profiles) are isolated vocal
 * stems; a full song's loudness/spectrum/crest are not comparable to a stem's, so taste targets live in their own
 * scope and are never mixed with those profiles. Ids match lib/decision/metrics.json.
 */
export const MIX_METRICS = [
  "integrated_lufs",
  "lra_lu",
  "true_peak_dbtp",
  "crest_active_db",
  "boxiness_250hz_rel_db",
  "presence_3k5_rel_db",
  "sibilance_5k9k_rel_db",
] as const;
export type MixMetricId = (typeof MIX_METRICS)[number];

/** One song that defines the user's taste. `measured` is null until the user's own copy has been measured: nothing is invented. */
export interface TasteReference {
  id: string;
  artist: string;
  /** null = the user picks the track (e.g. "anything by this artist"). */
  track: string | null;
  /** The user can switch any reference off without deleting it. */
  enabled: boolean;
  measured: Partial<Record<MixMetricId, number>> | null;
}

export type StepWhere = "app" | "bandlab";

export interface TemplateStep {
  id: string;
  where: StepWhere;
  title: string;
  /** Plain instruction. BandLab UI wording is not verified (see Template.unverified). */
  do: string;
  /** Marks a step that depends on a BandLab behaviour nobody has confirmed. */
  bandlabUnverified?: boolean;
  /** A step that measures the user's audio against the taste target. */
  check?: MixMetricId[];
}

export interface Template {
  id: string;
  label: string;
  version: number;
  /** Everything here must work on BandLab's free tier. */
  tier: "free";
  targetScope: "full-mix";
  references: TasteReference[];
  /** Starting vocal preset; the user can pick any. Presets are placeholders until calibrated. */
  preset: PresetId;
  steps: TemplateStep[];
  /** What this template assumes but has not confirmed. Shown to the user. */
  unverified: string[];
}

export interface TasteMetric {
  median: number;
  min: number;
  max: number;
  /** How many enabled, measured references this metric came from. */
  n: number;
}

export interface TasteTarget {
  metrics: Partial<Record<MixMetricId, TasteMetric>>;
  /** Enabled references that contributed. */
  used: string[];
  /** Enabled references with no measurements yet. */
  awaiting: string[];
  /** "none" = no targets, "low" = fewer than 3 references, "ok" = 3 or more. */
  confidence: "none" | "low" | "ok";
}
