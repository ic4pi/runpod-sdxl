import type { ChainConfig } from "../dsp/config";

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export type PresetId = "neutral" | "trap" | "boom-bap" | "drill" | "melodic-rap";

export interface Preset {
  id: PresetId;
  label: string;
  /** One line shown in the picker. */
  description: string;
  /**
   * Authored, never inferred from a track (rule 7). Only the differences from DEFAULT_CHAIN_CONFIG are listed;
   * arrays (EQ bands) replace the default wholesale.
   */
  overrides: DeepPartial<ChainConfig>;
  /** Every preset value is a placeholder until tuned on real phone-mic vocals. */
  calibration: "TODO: CALIBRATE — corpus: N>=50 real phone-recorded rap vocals per genre, A/B-judged against the neutral chain";
}
