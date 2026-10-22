import type { Preset } from "./types";

export const drill: Preset = {
  id: "drill",
  label: "Drill",
  description: "Dry, tight and aggressive: high-pass, hard compression, bright top, almost no room.",
  overrides: {
    stages: {
      hpf: { params: { frequencyHz: 100 } },
      expander: { params: { ratio: 2, rangeDb: -14 } },
      deess: { params: { thresholdDbfs: -33, ratio: 4.5 } },
      eq: {
        params: {
          bands: [
            { type: "peaking", frequencyHz: 300, gainDb: -3, q: 1.1 },
            { type: "peaking", frequencyHz: 4000, gainDb: 3, q: 0.9 },
            { type: "highshelf", frequencyHz: 10000, gainDb: 2, q: 0.7071068 },
          ],
        },
      },
      compressor: { params: { thresholdDb: -24, ratio: 5, kneeDb: 4, attackMs: 5, releaseMs: 70, makeupDb: 6 } },
      saturation: { params: { driveDb: 7, mix: 0.2 } },
      space: { params: { reverb: { mix: 0.04, decaySec: 0.4, preDelayMs: 8 } } },
    },
  },
  calibration: "TODO: CALIBRATE — corpus: N>=50 real phone-recorded rap vocals per genre, A/B-judged against the neutral chain",
};
