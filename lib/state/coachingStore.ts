"use client";

import { create } from "zustand";
import { DEFAULT_CONTEXT } from "../decision/default";
import type { UserMetrics } from "../decision/types";
import { createMeasureClient, type MeasureClient } from "../dsp/measure/client";
import { extractMetrics } from "../reference/extract";
import { useChain } from "./chainStore";

export type MeasureTarget = "original" | "processed";

interface CoachingState {
  /** null = no reference selected (the default). */
  profileId: string | null;
  target: MeasureTarget;
  metrics: UserMetrics | null;
  busy: boolean;
  error: string | null;
  setProfile(id: string | null): void;
  setTarget(t: MeasureTarget): void;
  measure(): Promise<void>;
}

let client: MeasureClient | null = null;
let token = 0;

export const useCoaching = create<CoachingState>()((set, get) => ({
  profileId: null,
  target: "original",
  metrics: null,
  busy: false,
  error: null,

  setProfile: (id) => set({ profileId: id }),
  setTarget(t) {
    set({ target: t, metrics: null });
    void get().measure();
  },

  /** Measures the chosen audio with the Phase 1 module (in its worker) and extracts the declared metrics. */
  async measure() {
    const { analysis, result } = useChain.getState();
    const { target } = get();
    const signal = target === "original" ? analysis?.prepared : result?.processed.getChannelData(0);
    if (!analysis || !signal) {
      set({ metrics: null, error: null, busy: false });
      return;
    }
    const mine = ++token;
    set({ busy: true, error: null });
    try {
      const sr = analysis.sampleRate;
      const np = analysis.noisePrint;
      const print =
        np && np.verdict.ok
          ? { sampleRate: sr, channels: [signal.slice(Math.round(np.startSec * sr), Math.round((np.startSec + np.lengthSec) * sr))] }
          : null;
      client ??= createMeasureClient();
      const report = await client.measure({ sampleRate: sr, channels: [signal] }, print);
      if (mine !== token) return; // a newer measurement superseded this one
      const metrics = extractMetrics(report, { durationSec: signal.length / sr, sampleRate: sr, channels: 1 }, DEFAULT_CONTEXT.metrics);
      set({ metrics, busy: false });
    } catch (e) {
      if (mine === token) set({ busy: false, metrics: null, error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
