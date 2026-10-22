import type { Preset } from "./types";

/** The Phase 2 default chain, unchanged. The baseline every other preset is a difference from. */
export const neutral: Preset = {
  id: "neutral",
  label: "Neutral (default)",
  description: "The default chain with no genre tuning.",
  overrides: {},
  calibration: "TODO: CALIBRATE — corpus: N>=50 real phone-recorded rap vocals per genre, A/B-judged against the neutral chain",
};
