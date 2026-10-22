import { DEFAULT_THRESHOLDS, type MeasureThresholds } from "./measure/thresholds";

/**
 * SINGLE SOURCE OF TRUTH for every chain parameter. Stage code (lib/dsp/chain/*) reads from this
 * object and contains no tuning numbers. The object is plain data, so presets and tests can swap it
 * wholesale (`renderChain(src, myConfig)`). Rule 7: values here are authored defaults, never inferred per track.
 *
 * TODO: CALIBRATE every default below on real phone-mic rap vocals.
 */

/** Fixed order (non-negotiable rule 5). `noisePrint` is analysis-only (no audio change); `expander` is the soft gate in the noise-reduction slot. */
export const CHAIN_ORDER = [
  "clippingCheck",
  "noisePrint",
  "hpf",
  "noiseReduction",
  "expander",
  "deplosive",
  "deess",
  "eq",
  "compressor",
  "saturation",
  "space",
  "limiter",
] as const;
export type StageId = (typeof CHAIN_ORDER)[number];

/** Where each stage runs. native = OfflineAudioContext graph; js = sample-domain code in a worker; analysis = no audio change. */
export const STAGE_KIND: Record<StageId, "native" | "js" | "analysis"> = {
  clippingCheck: "analysis",
  noisePrint: "analysis",
  hpf: "native",
  noiseReduction: "js",
  expander: "js",
  deplosive: "js",
  deess: "js",
  eq: "native",
  compressor: "js",
  saturation: "native",
  space: "native",
  limiter: "js",
};

export interface StageConfig<P> {
  label: string;
  /** Shown in the UI: why this stage exists. */
  rationale: string;
  /** Default bypass state; the UI toggles a copy of this. */
  bypass: boolean;
  params: P;
}

export interface NoisePrintParams {
  minSec: number;
  maxSec: number;
  /** Layer 2: energy stability. Block RMS spread (max - min, dB) over blockSec blocks. */
  blockSec: number;
  maxBlockSpreadDb: number;
  /** Layer 3: bumps. Fine-frame RMS max vs median (dB). */
  fineFrameSec: number;
  maxBumpOverMedianDb: number;
  /** Layer 4: RNNoise voice-activity probability per 10 ms frame. */
  vad: { enabled: boolean; threshold: number; maxSpeechFraction: number };
  /** Layer 5: voiced-periodicity (normalised autocorrelation in the F0 range, mains harmonics excluded). */
  harmonic: {
    enabled: boolean;
    f0MinHz: number;
    f0MaxHz: number;
    frameSec: number;
    /** First-difference pre-emphasis coefficient; whitens low-frequency room rumble so it isn't mistaken for pitch. */
    preEmphasis: number;
    minCorrelation: number;
    maxVoicedFraction: number;
    /** Candidates within toleranceHz of a multiple of these are treated as hum, not voice. */
    mainsHz: readonly number[];
    mainsToleranceHz: number;
    /** Frames quieter than this (dBFS RMS) are not tested for periodicity. */
    minFrameDbfs: number;
  };
}

export interface ExportConfig {
  /** Integrated loudness the export is brought to (LUFS). */
  targetLufs: number;
  /** Accept an export whose measured loudness is within this of the target (LU). */
  loudnessToleranceLu: number;
  /** Gain/limiter passes tried to reach the target under the true-peak ceiling. */
  maxIterations: number;
  /** Floor for the measured loudness-per-dB-of-gain slope used to extrapolate (the limiter makes it < 1). */
  minLoudnessSlope: number;
  /** A candidate whose limiter pulls peaks down further than this is rejected: the ceiling and the sound win over the loudness target. */
  maxLimiterReductionDb: number;
  /** Integrated LUFS needs at least this much audio (BS.1770 3 s short-term window). Shorter clips get the limiter only. */
  minSecondsForLoudness: number;
  wav: { bitDepth: 16 | 32; dither: boolean; ditherSeed: number };
  mp3: {
    bitrateKbps: number;
    /** The MP3 decoder can overshoot the PCM peak; the limiter ceiling is lowered by this for MP3 exports. */
    ceilingMarginDb: number;
    /** Samples handed to the encoder per call (one MPEG-1 Layer III frame). */
    chunkSamples: number;
    /** Where the unmodified LAME-derived encoder is served from (see public/licenses). */
    workerUrl: string;
  };
  filename: {
    separator: string;
    /** Characters kept per field (Unicode code points). */
    maxFieldChars: number;
    /** Hard cap on the UTF-8 byte length of the base name. */
    maxBytes: number;
    emptyArtist: string;
    emptyTrack: string;
  };
}

export interface StorageConfig {
  /** Saved sessions kept in IndexedDB; the oldest is evicted past this (each holds the full source PCM). */
  maxSessions: number;
  /** Autosave waits this long after the last change. */
  autosaveDebounceMs: number;
  /** Ask the browser to mark storage persistent so it is not evicted under pressure. */
  requestPersistence: boolean;
}

export interface ChainConfig {
  /** Internal processing rate and channel count (mono). RNNoise requires 48 kHz. */
  internalSampleRate: number;
  export: ExportConfig;
  storage: StorageConfig;
  stages: {
    clippingCheck: StageConfig<{ detect: MeasureThresholds["clipping"] }>;
    noisePrint: StageConfig<NoisePrintParams>;
    hpf: StageConfig<{
      frequencyHz: number;
      /** Linear Q of each cascaded 2nd-order section (Butterworth 4th order = two sections). */
      qs: readonly number[];
    }>;
    noiseReduction: StageConfig<{
      rnnoise: {
        wasmUrl: string;
        sampleRate: number;
        frameSamples: number;
        /** RNNoise expects 16-bit-range floats. */
        pcmScale: number;
        /** Output delay of rnnoise_process_frame, measured in tests/rnnoise.test.ts. */
        latencySamples: number;
        /** 0 = dry, 1 = fully denoised. */
        wet: number;
      };
    }>;
    expander: StageConfig<{
      thresholdMode: "relative-to-print" | "absolute";
      /** Threshold = noise floor (from print) + this. */
      thresholdOverNoiseDb: number;
      /** Used when no valid noise print exists, or thresholdMode is "absolute". */
      absoluteThresholdDbfs: number;
      ratio: number;
      kneeDb: number;
      /** Maximum attenuation (negative dB). The gate can never close fully: this is the floor. */
      rangeDb: number;
      detectorMs: number;
      /** Envelope ripple smaller than this never re-opens the gate (prevents gain flutter on low-frequency tails). */
      openDeadbandDb: number;
      /** Time to reopen. */
      attackMs: number;
      /** Gain is held open this long after the level drops, so word tails are not chopped. */
      holdMs: number;
      /** Time to close after hold. */
      releaseMs: number;
    }>;
    deplosive: StageConfig<{
      detect: MeasureThresholds["plosive"] & {
        frameMs: number;
        /** Event start must rise this much over the preceding window (the "transient trigger"). */
        onsetRiseDb: number;
        onsetWindowMs: number;
        /**
         * When clipping-check says the file is clipped, the required onset rise grows by this. One-sided
         * clipping makes DC-like LF shifts that follow the syllable envelope (slow onset); real pops start abruptly.
         */
        clippedExtraRiseDb: number;
      };
      apply: {
        shelfHz: number;
        depthDb: number;
        padBeforeMs: number;
        padAfterMs: number;
        attackMs: number;
        releaseMs: number;
        /** Q of the 2nd-order low-pass whose output is subtracted to make the shelf dip. */
        lowpassQ: number;
      };
    }>;
    deess: StageConfig<{
      /** Detection band (sidechain). */
      bandLowHz: number;
      bandHighHz: number;
      filterQ: number;
      /**
       * Corner of the zero-phase low-pass that splits the signal: everything above it is the part that gets
       * turned down (a dynamic high shelf), everything below passes untouched.
       */
      shelfHz: number;
      /** Sidechain (band-passed) peak-envelope threshold, dBFS. */
      thresholdDbfs: number;
      ratio: number;
      /** Maximum reduction of the band (negative dB). */
      maxReductionDb: number;
      attackMs: number;
      releaseMs: number;
    }>;
    eq: StageConfig<{
      bands: readonly {
        type: "peaking" | "lowshelf" | "highshelf";
        frequencyHz: number;
        gainDb: number;
        /** Linear Q (ignored by shelves). */
        q: number;
      }[];
    }>;
    compressor: StageConfig<{
      thresholdDb: number;
      ratio: number;
      kneeDb: number;
      attackMs: number;
      releaseMs: number;
      makeupDb: number;
    }>;
    saturation: StageConfig<{
      /** y = tanh(d*x)/d with d = 10^(driveDb/20): unity slope at 0, softer peaks. */
      driveDb: number;
      /** Parallel blend, 0 = dry. */
      mix: number;
      curveSize: number;
      oversample: "none" | "2x" | "4x";
      outputTrimDb: number;
    }>;
    space: StageConfig<{
      reverb: {
        /** Wet send level (linear), added to the dry path. 0 = off. */
        mix: number;
        decaySec: number;
        preDelayMs: number;
        dampingHz: number;
        wetHighpassHz: number;
        irSeed: number;
        /** IR length as a multiple of decaySec. */
        irLengthDecays: number;
        /** Level of the IR's -60 dB point, used for the decay slope. */
        decayDb: number;
      };
      delay: {
        mix: number;
        timeMs: number;
        feedback: number;
        lowpassHz: number;
        /** Number of echoes rendered past the end of the input. */
        tailRepeats: number;
      };
      /** Extra render length for reverb/delay tails. */
      tailPaddingSec: number;
    }>;
    limiter: StageConfig<{
      ceilingDbtp: number;
      lookaheadMs: number;
      releaseMs: number;
    }>;
  };
  /** A/B and display. */
  ab: {
    /** Fallback for files shorter than the loudness window. */
    minLoudnessSec: number;
    crossfadeMs: number;
  };
}

export const DEFAULT_CHAIN_CONFIG: ChainConfig = {
  internalSampleRate: 48000,
  storage: { maxSessions: 5, autosaveDebounceMs: 800, requestPersistence: true },
  export: {
    targetLufs: -14,
    loudnessToleranceLu: 0.5,
    maxIterations: 8,
    minLoudnessSlope: 0.2,
    maxLimiterReductionDb: 6,
    minSecondsForLoudness: 3,
    wav: { bitDepth: 16, dither: true, ditherSeed: 1 },
    mp3: { bitrateKbps: 192, ceilingMarginDb: 0.5, chunkSamples: 1152, workerUrl: "/workers/mp3-worker.js" },
    filename: { separator: "_", maxFieldChars: 60, maxBytes: 200, emptyArtist: "artist", emptyTrack: "track" },
  },
  stages: {
    clippingCheck: {
      label: "Clipping check",
      rationale:
        "Finds flat-topped (clipped) peaks. Clipping can't be repaired here, but it changes how aggressive the other stages should be, so it is reported first.",
      bypass: false,
      params: { detect: { ...DEFAULT_THRESHOLDS.clipping } },
    },
    noisePrint: {
      label: "Noise print",
      rationale:
        "A 2-5 s clip of just room noise tells the chain what 'silence' sounds like in this recording. It is rejected if it contains speech or bumps.",
      bypass: false,
      params: {
        minSec: 2,
        maxSec: 5,
        blockSec: 0.1,
        maxBlockSpreadDb: 6,
        fineFrameSec: 0.01,
        maxBumpOverMedianDb: 10,
        vad: { enabled: true, threshold: 0.5, maxSpeechFraction: 0.05 },
        harmonic: {
          enabled: true,
          f0MinHz: 80,
          f0MaxHz: 400,
          frameSec: 0.04,
          preEmphasis: 0.95,
          minCorrelation: 0.5,
          maxVoicedFraction: 0.1,
          mainsHz: [50, 60],
          mainsToleranceHz: 3,
          minFrameDbfs: -70,
        },
      },
    },
    hpf: {
      label: "High-pass filter",
      rationale: "Removes rumble, handling thump and wind below the voice so later stages don't waste effort on it.",
      bypass: false,
      params: { frequencyHz: 70, qs: [0.5411961, 1.306563] },
    },
    noiseReduction: {
      label: "Noise reduction (RNNoise)",
      rationale:
        "A small neural network (RNNoise) that lowers steady background noise like fans and room hiss while keeping the voice.",
      bypass: false,
      params: {
        rnnoise: {
          wasmUrl: "/wasm/rnnoise.wasm",
          sampleRate: 48000,
          frameSamples: 480,
          pcmScale: 32768,
          latencySamples: 480,
          wet: 1,
        },
      },
    },
    expander: {
      label: "Soft expander (gate)",
      rationale:
        "Gently turns the level down between words. It is a soft expander with a floor, a hold and a slow release, so it can never chop the tail off a word.",
      bypass: false,
      params: {
        thresholdMode: "relative-to-print",
        thresholdOverNoiseDb: 8,
        absoluteThresholdDbfs: -50,
        ratio: 1.8,
        kneeDb: 10,
        rangeDb: -12,
        detectorMs: 10,
        openDeadbandDb: 0.5,
        attackMs: 4,
        holdMs: 120,
        releaseMs: 300,
      },
    },
    deplosive: {
      label: "De-plosive",
      rationale:
        "Dips the low end briefly on 'p' and 'b' pops. Detection can be wrong on noisy phone audio, so you confirm each detected pop before anything is changed.",
      bypass: false,
      params: {
        detect: {
          ...DEFAULT_THRESHOLDS.plosive,
          frameMs: 10,
          onsetRiseDb: 9,
          onsetWindowMs: 60,
          clippedExtraRiseDb: 30,
        },
        apply: {
          shelfHz: 150,
          depthDb: -12,
          padBeforeMs: 10,
          padAfterMs: 60,
          attackMs: 5,
          releaseMs: 40,
          lowpassQ: 0.7071068,
        },
      },
    },
    deess: {
      label: "De-esser",
      rationale:
        "Turns down harsh 's' and 't' sounds (5-9 kHz). It sits before the compressor so the compressor doesn't make the harshness louder.",
      bypass: false,
      params: {
        bandLowHz: 5000,
        bandHighHz: 9000,
        filterQ: 0.7071068,
        shelfHz: 4500,
        thresholdDbfs: -32,
        ratio: 4,
        maxReductionDb: -10,
        attackMs: 0.5,
        releaseMs: 30,
      },
    },
    eq: {
      label: "EQ",
      rationale: "Trims muddy low-mids and adds a little presence and air so the vocal sits clearly on a beat.",
      bypass: false,
      params: {
        bands: [
          { type: "peaking", frequencyHz: 250, gainDb: -2, q: 1 },
          { type: "peaking", frequencyHz: 3500, gainDb: 2, q: 0.9 },
          { type: "highshelf", frequencyHz: 10000, gainDb: 2.5, q: 0.7071068 },
        ],
      },
    },
    compressor: {
      label: "Compressor",
      rationale: "Evens out loud and quiet words so the vocal stays steady and forward.",
      bypass: false,
      params: { thresholdDb: -20, ratio: 3.5, kneeDb: 8, attackMs: 10, releaseMs: 100, makeupDb: 4 },
    },
    saturation: {
      label: "Saturation",
      rationale: "Adds light harmonic warmth so the vocal sounds fuller on small speakers.",
      bypass: false,
      params: { driveDb: 6, mix: 0.2, curveSize: 4096, oversample: "4x", outputTrimDb: 0 },
    },
    space: {
      label: "Reverb / delay",
      rationale: "A little room (and optional echo) so the vocal doesn't sound dry and pasted on. Off-by-default delay.",
      bypass: false,
      params: {
        reverb: {
          mix: 0.08,
          decaySec: 0.7,
          preDelayMs: 12,
          dampingHz: 6000,
          wetHighpassHz: 300,
          irSeed: 7,
          irLengthDecays: 1,
          decayDb: -60,
        },
        delay: { mix: 0, timeMs: 140, feedback: 0.25, lowpassHz: 5000, tailRepeats: 4 },
        tailPaddingSec: 1,
      },
    },
    limiter: {
      label: "Limiter",
      rationale: "Last safety net: stops peaks (including inter-sample peaks) going over the ceiling so the export doesn't distort.",
      bypass: false,
      params: { ceilingDbtp: -1, lookaheadMs: 5, releaseMs: 60 },
    },
  },
  ab: { minLoudnessSec: 3, crossfadeMs: 15 },
};
