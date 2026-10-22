import { measureClipping } from "../dsp/measure/clipping";
import { measureCorrelation } from "../dsp/measure/correlation";
import { measureCrest } from "../dsp/measure/crest";
import { measureDcOffset } from "../dsp/measure/dcOffset";
import { measureHum } from "../dsp/measure/hum";
import { measureLoudness } from "../dsp/measure/loudness";
import { measureNoise } from "../dsp/measure/noise";
import { measurePlosives } from "../dsp/measure/plosive";
import { measureThirdOctave } from "../dsp/measure/thirdOctave";
import { measureTruePeak } from "../dsp/measure/truePeak";
import type { MeasureReport } from "../dsp/measure";

/**
 * The only bridge from a metric's `measure_fn` name to Phase 1. `reportKey` says where that function's
 * result lives in a MeasureReport. Phase 3 reads these results; it never recomputes a measurement.
 */
export const MEASURE_FUNCTIONS = {
  measureLoudness: { fn: measureLoudness, reportKey: "loudness" },
  measureTruePeak: { fn: measureTruePeak, reportKey: "truePeak" },
  measureThirdOctave: { fn: measureThirdOctave, reportKey: "thirdOctave" },
  measureCrest: { fn: measureCrest, reportKey: "crest" },
  measureCorrelation: { fn: measureCorrelation, reportKey: "correlation" },
  measureNoise: { fn: measureNoise, reportKey: "noise" },
  measureClipping: { fn: measureClipping, reportKey: "clipping" },
  measureDcOffset: { fn: measureDcOffset, reportKey: "dcOffset" },
  measureHum: { fn: measureHum, reportKey: "hum" },
  measurePlosives: { fn: measurePlosives, reportKey: "plosive" },
} as const satisfies Record<string, { fn: (...a: never[]) => unknown; reportKey: keyof MeasureReport }>;

export type MeasureFnName = keyof typeof MEASURE_FUNCTIONS;
