"use client";

import { useEffect } from "react";
import { AbPlayerPanel } from "@/components/chain/AbPlayerPanel";
import { CoachingSection } from "@/components/coaching/CoachingSection";
import { ChainPanel } from "@/components/chain/ChainPanel";
import { SourceLoader } from "@/components/chain/SourceLoader";
import { useChain } from "@/lib/state/chainStore";

export default function RepairPage() {
  const { source, analysis, render, busy, error, popDecision, result } = useChain();
  useEffect(() => {
    // Dev-only hooks for scripts/e2e-chain.mjs (not shipped in production builds).
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as Record<string, unknown>;
    w.__chain = useChain;
    void import("@/lib/dsp/chain/native").then((m) => (w.__native = m));
    void import("@/lib/dsp/config").then((m) => (w.__config = m));
    void import("@/lib/state/coachingStore").then((m) => (w.__coaching = m.useCoaching));
  }, []);
  const blocked = !analysis || busy !== null || popDecision === "pending";
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4 text-sm">
      <h1 className="text-lg font-semibold">Repair vocal</h1>
      <SourceLoader />
      {source && (
        <>
          <div className="flex items-center gap-3">
            <button
              className="rounded bg-emerald-600 px-4 py-1.5 font-medium hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={blocked}
              onClick={() => void render()}
              data-testid="render"
            >
              {result ? "Re-render" : "Render"}
            </button>
            {popDecision === "pending" && <span className="text-xs text-amber-400">Confirm or skip the detected pops to continue.</span>}
            {busy && <span className="text-xs text-amber-400" data-testid="busy">{busy}...</span>}
          </div>
          {error && (
            <pre className="whitespace-pre-wrap rounded border border-red-700 bg-red-950 p-2 text-red-300" data-testid="error">
              {error}
            </pre>
          )}
          <AbPlayerPanel />
          <CoachingSection />
          <ChainPanel />
        </>
      )}
    </main>
  );
}
