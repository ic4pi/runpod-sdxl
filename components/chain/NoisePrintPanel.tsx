"use client";

import { useState } from "react";
import { useChain } from "@/lib/state/chainStore";

export function NoisePrintPanel() {
  const { analysis, cfg, printStartSec, setPrintStart, bypass } = useChain();
  const [draft, setDraft] = useState("");
  const np = analysis?.noisePrint;
  const exp = cfg.stages.expander.params;
  if (!analysis) return null;
  if (bypass.noisePrint ?? cfg.stages.noisePrint.bypass) {
    return <p className="text-xs text-amber-400">Noise print skipped. The expander uses its absolute fallback threshold ({exp.absoluteThresholdDbfs} dBFS).</p>;
  }
  if (!np) return null;
  const v = np.verdict;
  return (
    <div className="space-y-2 text-xs">
      <p>
        Print: {np.startSec.toFixed(2)}-{(np.startSec + np.lengthSec).toFixed(2)} s ({printStartSec === null ? "auto: quietest window" : "manual"}).{" "}
        {v.ok ? (
          <span className="text-emerald-400">Accepted. Noise floor {v.noiseFloorDbfs?.toFixed(1)} dBFS.</span>
        ) : (
          <span className="text-red-400">Rejected.</span>
        )}
      </p>
      {!v.ok && (
        <ul className="list-disc space-y-0.5 pl-5 text-red-300">
          {v.rejections.map((r, i) => (
            <li key={i}>
              <span className="uppercase text-red-400">{r.layer}</span>: {r.message}
            </li>
          ))}
        </ul>
      )}
      <p className="text-neutral-400">
        {v.ok && exp.thresholdMode === "relative-to-print"
          ? `Expander threshold = noise floor + ${exp.thresholdOverNoiseDb} dB = ${((v.noiseFloorDbfs ?? 0) + exp.thresholdOverNoiseDb).toFixed(1)} dBFS.`
          : `No valid print: expander falls back to ${exp.absoluteThresholdDbfs} dBFS.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="w-24 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5"
          placeholder="start (s)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="rounded bg-neutral-700 px-2 py-0.5 hover:bg-neutral-600"
          onClick={() => {
            const n = Number(draft);
            if (draft.trim() !== "" && Number.isFinite(n) && n >= 0) void setPrintStart(n);
          }}
        >
          Use this start
        </button>
        <button className="rounded bg-neutral-700 px-2 py-0.5 hover:bg-neutral-600" onClick={() => void setPrintStart(null)}>
          Auto-pick quietest
        </button>
      </div>
    </div>
  );
}
