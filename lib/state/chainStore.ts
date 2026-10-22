"use client";

import { create } from "zustand";
import { levelFromReport, levelMatchGains, type MatchGains } from "../dsp/chain/levelMatch";
import { createChainWorkerClient, type ChainWorkerClient } from "../dsp/chain/chainClient";
import { analyzeSource, renderChain, type ChainRenderResult } from "../dsp/chain/render";
import { confirmPlosives, type ChainAnalysis, type ConfirmedPlosives } from "../dsp/chain/types";
import { DEFAULT_CHAIN_CONFIG, type ChainConfig, type StageId } from "../dsp/config";
import { cloneConfig, setByPath, type BypassMap } from "../dsp/configUtil";
import type { ExportFormat } from "../export/exporter";
import { configForPreset, DEFAULT_PRESET_ID, type PresetId } from "../presets";
import type { PopDecisionRecord, SessionRecord, StoredAudio } from "../storage/idb";
import { renderHooks } from "./renderHooks";
import { createMeasureClient, type MeasureClient } from "../dsp/measure/client";

export type PopDecision = "none-needed" | "pending" | "confirmed" | "skipped";

interface ChainState {
  source: { name: string; buffer: AudioBuffer } | null;
  cfg: ChainConfig;
  /** Which preset the config was resolved from. `cfg` may have been edited since (see presetIsModified in the UI). */
  presetId: PresetId;
  metadata: { artist: string; track: string };
  exportFormat: ExportFormat;
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
  /** Switch preset: resolve a complete config, keep the analysis (presets never change what analysis reads), re-render. */
  switchPreset(id: PresetId): Promise<void>;
  setMetadata(m: Partial<{ artist: string; track: string }>): void;
  setExportFormat(f: ExportFormat): void;
  /** Rebuild state from a saved session + its stored source PCM, re-analyze, re-apply the saved pop decision. */
  restore(session: SessionRecord, audio: StoredAudio): Promise<void>;
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
  cfg: configForPreset(DEFAULT_PRESET_ID),
  presetId: DEFAULT_PRESET_ID,
  metadata: { artist: "", track: "" },
  exportFormat: "wav",
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
    let renderId: string | null = null;
    try {
      renderId = (await renderHooks.begin?.()) ?? null;
    } catch {
      /* persistence trouble must not stop the render */
    }
    const endHook = (ok: boolean, error?: string) => void renderHooks.end?.(renderId, ok, error)?.catch(() => undefined);
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
      endHook(true);
    } catch (e) {
      set({ busy: null, error: e instanceof Error ? e.message : String(e) });
      endHook(false, e instanceof Error ? e.message : String(e));
    }
  },

  resetConfig() {
    set((s) => ({ cfg: configForPreset(s.presetId), bypass: {}, result: null, match: null }));
    if (get().source) void get().analyze();
  },

  async switchPreset(id) {
    set({ presetId: id, cfg: configForPreset(id), result: null, match: null, error: null });
    const { analysis, popDecision } = get();
    if (analysis && popDecision !== "pending") await get().render();
  },

  setMetadata: (m) => set((s) => ({ metadata: { ...s.metadata, ...m } })),
  setExportFormat: (f) => set({ exportFormat: f }),

  async restore(session, audio) {
    const ch = audio.channels[0];
    if (!ch || audio.channels.length !== 1) throw new Error("Saved source is not mono; it was not saved by this app version.");
    const buffer = new AudioBuffer({ length: audio.length, sampleRate: audio.sampleRate, numberOfChannels: 1 });
    buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, 0);
    set({
      source: { name: session.name, buffer },
      cfg: session.config,
      presetId: session.presetId as PresetId,
      bypass: session.bypass,
      printStartSec: session.printStartSec,
      metadata: session.metadata,
      exportFormat: session.exportFormat,
      analysis: null,
      original: null,
      result: null,
      match: null,
      confirmed: null,
      popDecision: "none-needed",
      error: null,
    });
    await get().analyze();
    const a = get().analysis;
    if (!a) return;
    const rec: PopDecisionRecord = session.pops.decision;
    if (get().popDecision === "pending") {
      if (rec === "confirmed") get().confirmPops(session.pops.confirmedIds.filter((id) => a.plosiveCandidates.some((c) => c.id === id)));
      else if (rec === "skipped") get().skipPops();
    }
  },
}));
