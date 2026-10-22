import type { Preset } from "./types";

export const trap: Preset = {
  id: "trap",
  label: "Trap",
  description: "Tight low end, bright and forward, firm compression, a touch of slapback.",
  overrides: {
    stages: {
      hpf: { params: { frequencyHz: 90 } },
      deess: { params: { thresholdDbfs: -34, ratio: 4.5 } },
      eq: {
        params: {
          bands: [
            { type: "peaking", frequencyHz: 280, gainDb: -3, q: 1 },
            { type: "peaking", frequencyHz: 3500, gainDb: 2.5, q: 0.9 },
            { type: "highshelf", frequencyHz: 10000, gainDb: 3, q: 0.7071068 },
          ],
        },
      },
      compressor: { params: { thresholdDb: -22, ratio: 4, kneeDb: 6, attackMs: 8, releaseMs: 80, makeupDb: 5 } },
      saturation: { params: { driveDb: 8, mix: 0.25 } },
      space: {
        params: {
          reverb: { mix: 0.06, decaySec: 0.5, preDelayMs: 10 },
          delay: { mix: 0.06, timeMs: 125, feedback: 0.25, lowpassHz: 4500 },
        },
      },
    },
  },
  calibration: "TODO: CALIBRATE — corpus: N>=50 real phone-recorded rap vocals per genre, A/B-judged against the neutral chain",
};
