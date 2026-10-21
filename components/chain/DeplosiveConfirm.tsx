"use client";

import { useEffect, useRef, useState } from "react";
import { useChain } from "@/lib/state/chainStore";

/** The "confirm?" step. Nothing is changed until the user presses Apply; Skip applies nothing. */
export function DeplosiveConfirm() {
  const { analysis, popDecision, confirmPops, skipPops, original, bypass, cfg } = useChain();
  const cands = analysis?.plosiveCandidates ?? [];
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => setPicked(new Set(cands.map((c) => c.id))), [analysis]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void ctxRef.current?.close(), []);

  if (bypass.deplosive ?? cfg.stages.deplosive.bypass) return null;
  if (!analysis) return null;
  if (cands.length === 0) return <p className="text-xs text-neutral-400">No pops detected. Nothing to confirm.</p>;

  const audition = async (startSec: number, durMs: number) => {
    if (!original) return;
    ctxRef.current ??= new AudioContext();
    const ctx = ctxRef.current;
    await ctx.resume();
    const s = ctx.createBufferSource();
    s.buffer = original;
    s.connect(ctx.destination);
    s.start(0, Math.max(0, startSec - 0.2), 0.4 + durMs / 1000);
  };

  return (
    <div className="space-y-2 rounded border border-amber-700 bg-amber-950/40 p-2 text-xs">
      <p className="font-medium text-amber-300">
        {cands.length} possible pop{cands.length > 1 ? "s" : ""} found. Detection can be wrong on noisy phone audio: confirm which to treat.
        {analysis.clipped && " This file is clipped, so detection is stricter and may miss real pops."}
      </p>
      <table className="w-full">
        <thead>
          <tr className="text-left text-neutral-400">
            <th />
            <th>time</th>
            <th>len</th>
            <th>LF peak</th>
            <th>LF share</th>
            <th>onset rise</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cands.map((c) => (
            <tr key={c.id}>
              <td>
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  disabled={popDecision !== "pending"}
                  onChange={(e) =>
                    setPicked((p) => {
                      const n = new Set(p);
                      e.target.checked ? n.add(c.id) : n.delete(c.id);
                      return n;
                    })
                  }
                />
              </td>
              <td>{c.startSec.toFixed(2)} s</td>
              <td>{c.durationMs} ms</td>
              <td>{c.lfPeakDbfs.toFixed(1)} dBFS</td>
              <td>{c.lfFractionDb.toFixed(1)} dB</td>
              <td>{c.onsetRiseDb.toFixed(0)} dB</td>
              <td>
                <button className="rounded bg-neutral-700 px-1.5 hover:bg-neutral-600" onClick={() => void audition(c.startSec, c.durationMs)}>
                  Listen
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {popDecision === "pending" ? (
        <div className="flex gap-2">
          <button className="rounded bg-emerald-600 px-2 py-1 font-medium hover:bg-emerald-500" onClick={() => confirmPops([...picked])}>
            Apply to {picked.size} selected
          </button>
          <button className="rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600" onClick={skipPops}>
            Skip de-plosive (change nothing)
          </button>
        </div>
      ) : (
        <p className="text-emerald-400">{popDecision === "confirmed" ? "Confirmed. These pops will be treated on render." : "Skipped. No pops will be treated."}</p>
      )}
    </div>
  );
}
