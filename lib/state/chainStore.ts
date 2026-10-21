"use client";

import { create } from "zustand";
import { levelFromReport, levelMatchGains, type MatchGains } from "../dsp/chain/levelMatch";
import { createChainWorkerClient, type ChainWorkerClient } from "../dsp/chain/chainClient";
import { analyzeSource, renderChain, type ChainRenderResult } from "../dsp/chain/render";
import { confirmPlosives, type ChainAnalysis, type ConfirmedPlosives } from "../dsp/chain/types";
import { DEFAULT_CHAIN_CONFIG, type ChainConfig, type StageId } from "../dsp/config";
import { cloneConfig, setByPath, type BypassMap } from "../dsp/configUtil";
import { createMeasureClient, type MeasureClient } from "../dsp/measure/client";

export type PopDecision = "none-needed" | "pending" | "confirmed" | "skipped";

interface ChainState {
  source: { name: string; buffer: AudioBuffer } | null;
  cfg: ChainConfig;
  bypass: BypassMap;
  printStartSec: number | null;
  analysis: ChainAnalysis | null;
  /** Mono internal-rate copy of the source as an AudioBuffer: the "A" side of A/B. */
  original: AudioBuffer | null;
  popDecision: PopDecision;
  confirmed: ConfirmedPlosives | null;
  result: ChainRenderResult | null;
  match: { gains: MatchGains } | { error: string } | null;
  busy: string | null;
  error: string | null;

  loadSource(name: string, buffer: AudioBuffer): Promise<void>;
  setBypass(id: StageId, v: boolean): void;
  setParam(path: (string | number)[], value: unknown): void;
  setPrintStart(sec: number | null): Promise<void>;
  analyze(): Promise<void>;
  confirmPops(ids: number[]): void;
  skipPops(): void;
  render(): Promise<void>;
  resetConfig(): void;
}

let chainWorker: ChainWorkerClient | null = null;
let measureClient: MeasureClient | null = null;
const worker = () => (chainWorker ??= createChainWorkerClient());
const measurer = () => (measureClient ??= createMeasureClient());

const toAudioBuffer = (x: Float32Array, sampleRate: number): AudioBuffer => {
  const b = new AudioBuffer({ length: x.length, sampleRate, numberOfChannels: 1 });
  b.copyToChannel(x as Float32Array<ArrayBuffer>, 0);
  return b;
};

/** Stages whose parameters change what analysis finds. */
const ANALYSIS_PATHS = new Set(["clippingCheck", "noisePrint"]);

export const useChain = create<ChainState>()((set, get) => ({
  source: null,
  cfg: cloneConfig(DEFAULT_CHAIN_CONFIG),
  bypass: {},
  printStartSec: null,
  analysis: null,
  original: null,
  popDecision: "none-needed",
  confirmed: null,
  result: null,
  match: null,
  busy: null,
  error: null,

  async loadSource(name, buffer) {
    set({ source: { name, buffer }, analysis: null, original: null, result: null, match: null, confirmed: null, popDecision: "none-needed", printStartSec: null, error: null });
    await get().analyze();
  },

  setBypass(id, v) {
    // bypass changes what the render does; analysis stays valid unless an analysis stage itself is toggled
    const invalidatesAnalysis = id === "clippingCheck" || id === "noisePrint" || id === "deplosive";
    set((s) => ({ bypass: { ...s.bypass, [id]: v }, result: null, match: null, ...(invalidatesAnalysis ? { analysis: null } : {}) }));
    if (invalidatesAnalysis && get().source) void get().analyze();
  },

  setParam(path, value) {
    const [, stage, , section] = path as string[];
    const changesAnalysis = ANALYSIS_PATHS.has(stage ?? "") || (stage === "deplosive" && section === "detect");
    set((s) => ({ cfg: setByPath(s.cfg, path, value), result: null, match: null, ...(changesAnalysis ? { analysis: null } : {}) }));
    if (changesAnalysis && get().source) void get().analyze();
  },

  async setPrintStart(sec) {
    set({ printStartSec: sec });
    await get().analyze();
  },

  async analyze() {
    const { source, cfg, bypass, printStartSec } = get();
    if (!source) return;
    set({ busy: "Analyzing", error: null });
    try {
      const analysis = await analyzeSource(source.buffer, cfg, worker(), { bypass, printStartSec });
      const original = toAudioBuffer(analysis.prepared, analysis.sampleRate);
      const needsDecision = analysis.plosiveCandidates.length > 0;
      set({
        analysis,
        original,
        result: null,
        match: null,
        confirmed: null,
        popDecision: needsDecision ? "pending" : "none-needed",
        busy: null,
      });
    } catch (e) {
      set({ busy: null, error: e instanceof Error ? e.message : String(e) });
    }
  },

  confirmPops(ids) {
    const a = get().analysis;
    if (!a) return;
    set({ confirmed: confirmPlosives(a.plosiveCandidates, ids), popDecision: "confirmed", result: null, match: null });
  },

  skipPops() {
    set({ confirmed: confirmPlosives([], []), popDecision: "skipped", result: null, match: null });
  },

  async render() {
    const { analysis, cfg, bypass, confirmed, popDecision, original } = get();
    if (!analysis || !original) return;
    if (popDecision === "pending") {
      set({ error: "Confirm or skip the detected pops first." });
      return;
    }
    set({ busy: "Rendering", error: null });
    try {
      const result = await renderChain(analysis, cfg, worker(), { bypass, confirmed });
      set({ result, busy: "Matching levels", match: null });
      try {
        const toPcm = (b: AudioBuffer) => ({ sampleRate: b.sampleRate, channels: [b.getChannelData(0)] });
        const [ro, rp] = await Promise.all([measurer().measure(toPcm(original)), measurer().measure(toPcm(result.processed))]);
        set({ match: { gains: levelMatchGains(levelFromReport(ro), levelFromReport(rp)) } });
      } catch (e) {
        set({ match: { error: e instanceof Error ? e.message : String(e) } });
      }
      set({ busy: null });
    } catch (e) {
      set({ busy: null, error: e instanceof Error ? e.message : String(e) });
    }
  },

  resetConfig() {
    set({ cfg: cloneConfig(DEFAULT_CHAIN_CONFIG), bypass: {}, result: null, match: null });
    if (get().source) void get().analyze();
  },
}));
