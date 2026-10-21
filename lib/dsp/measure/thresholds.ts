/**
 * Every detector threshold lives here. Nothing in the measurement or detector
 * code hardcodes one. Detectors take a `MeasureThresholds` argument that
 * defaults to DEFAULT_THRESHOLDS, so the whole object can be swapped.
 *
 * ALL VALUES ARE PLACEHOLDERS. They were chosen by reasoning, not by data.
 * The synthetic defect harness only proves the detector mechanics work.
 */
export interface MeasureThresholds {
  clipping: {
    /** A sample is "at the ceiling" if |x| >= ceiling * (1 - this). Ceiling = file's own max per polarity. */
    ceilingToleranceRel: number;
    /** Consecutive at-ceiling samples that make one clipping run. */
    minRunSamples: number;
    /** Detector fires at >= this many runs. */
    minRunsToFire: number;
    /** A true-peak "over" is an oversampled peak above this level. Reported, not part of the verdict. */
    trueOverDbtp: number;
  };
  hum: {
    /** Mains fundamentals tested. */
    mainsHz: readonly number[];
    /** Harmonics tested per fundamental (1 = fundamental only). */
    harmonics: number;
    /** A harmonic counts when its prominence over neighbouring bins is >= this. */
    harmonicProminenceDb: number;
    /** Detector fires when >= this many harmonics count. */
    minHarmonicsToFire: number;
  };
  plosive: {
    lfLowHz: number;
    lfHighHz: number;
    /** LF-band frame level must exceed this. */
    minLfDbfs: number;
    /** LF energy / full-band energy in the frame must exceed this (dB, negative). */
    minLfFractionDb: number;
    /** LF-band frame level must exceed the file's median LF level by this. Separates bursts from steady hum/rumble. */
    burstOverMedianDb: number;
    minDurationMs: number;
    maxDurationMs: number;
    /** Detector fires at >= this many events. */
    minEventsToFire: number;
    /** Ignore filter start-up transient. */
    settleSec: number;
  };
  dcOffset: {
    /** Detector fires when max |channel mean| (fraction of full scale) >= this. */
    fireAbsFs: number;
  };
  noise: {
    minPrintSec: number;
    maxPrintSec: number;
    /** Print is rejected when its loudest 100 ms block exceeds its quietest by more than this. */
    maxPrintSpreadDb: number;
    /** A file block is "speech" when its RMS is this far above the print RMS. */
    speechOverNoiseDb: number;
    minActiveSec: number;
  };
  crest: {
    /** 100 ms blocks below this RMS are excluded from active-crest. */
    activeBlockFloorDbfs: number;
  };
}

export const DEFAULT_THRESHOLDS: MeasureThresholds = {
  clipping: {
    // TODO: CALIBRATE against real phone clips (soft-clipped, AGC-limited, normalised-after-clip).
    ceilingToleranceRel: 1e-4,
    minRunSamples: 4,
    minRunsToFire: 2,
    trueOverDbtp: -1.0,
  },
  hum: {
    // TODO: CALIBRATE against real room/phone hum (50 Hz regions, rectifier-style 100/120 Hz dominant hum).
    mainsHz: [50, 60],
    harmonics: 4,
    harmonicProminenceDb: 10,
    minHarmonicsToFire: 2,
  },
  plosive: {
    // TODO: CALIBRATE against real plosives, incl. low male F0 (~90-110 Hz) which can leak into the LF band.
    lfLowHz: 20,
    lfHighHz: 80,
    minLfDbfs: -45,
    minLfFractionDb: -6,
    burstOverMedianDb: 12,
    minDurationMs: 20,
    maxDurationMs: 300,
    minEventsToFire: 2,
    settleSec: 0.25,
  },
  dcOffset: {
    // TODO: CALIBRATE. 0.005 FS is about -46 dBFS; phone ADC offsets are often far smaller or larger.
    fireAbsFs: 0.005,
  },
  noise: {
    // TODO: CALIBRATE print length/stability limits against what users actually record.
    minPrintSec: 2,
    maxPrintSec: 5,
    maxPrintSpreadDb: 10,
    speechOverNoiseDb: 10,
    minActiveSec: 1,
  },
  crest: {
    // TODO: CALIBRATE against real quiet-room phone floors.
    activeBlockFloorDbfs: -50,
  },
};
