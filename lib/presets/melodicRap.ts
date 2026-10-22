import type { Preset } from "./types";

export const melodicRap: Preset = {
  id: "melodic-rap",
  label: "Melodic rap",
  description: "Airy and smooth: lighter compression, long bright shelf, more reverb and a soft echo.",
  overrides: {
    stages: {
      eq: {
        params: {
          bands: [
            { type: "peaking", frequencyHz: 250, gainDb: -2, q: 1 },
            { type: "peaking", frequencyHz: 3500, gainDb: 1.5, q: 0.9 },
            { type: "highshelf", frequencyHz: 12000, gainDb: 3.5, q: 0.7071068 },
          ],
        },
      },
      compressor: { params: { thresholdDb: -20, ratio: 2.5, kneeDb: 10, attackMs: 12, releaseMs: 140, makeupDb: 3.5 } },
      saturation: { params: { driveDb: 4, mix: 0.15 } },
      space: {
        params: {
          reverb: { mix: 0.14, decaySec: 1.1, preDelayMs: 20, dampingHz: 5000 },
          delay: { mix: 0.1, timeMs: 250, feedback: 0.35, lowpassHz: 4000 },
        },
      },
    },
  },
  calibration: "TODO: CALIBRATE — corpus: N>=50 real phone-recorded rap vocals per genre, A/B-judged against the neutral chain",
};
