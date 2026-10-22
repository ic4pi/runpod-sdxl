import type { Preset } from "./types";

export const boomBap: Preset = {
  id: "boom-bap",
  label: "Boom-bap",
  description: "Warmer and more natural, gentler compression, a little room.",
  overrides: {
    stages: {
      hpf: { params: { frequencyHz: 80 } },
      expander: { params: { rangeDb: -9 } },
      eq: {
        params: {
          bands: [
            { type: "peaking", frequencyHz: 250, gainDb: -1.5, q: 1 },
            { type: "peaking", frequencyHz: 3000, gainDb: 1.5, q: 0.9 },
            { type: "highshelf", frequencyHz: 9000, gainDb: 1.5, q: 0.7071068 },
          ],
        },
      },
      compressor: { params: { thresholdDb: -18, ratio: 3, kneeDb: 10, attackMs: 15, releaseMs: 120, makeupDb: 3 } },
      saturation: { params: { driveDb: 5, mix: 0.3 } },
      space: { params: { reverb: { mix: 0.1, decaySec: 0.8, preDelayMs: 14 } } },
    },
  },
  calibration: "TODO: CALIBRATE — corpus: N>=50 real phone-recorded rap vocals per genre, A/B-judged against the neutral chain",
};
