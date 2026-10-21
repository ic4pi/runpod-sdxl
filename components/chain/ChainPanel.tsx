"use client";

import { useState } from "react";
import { CHAIN_ORDER, STAGE_KIND, type StageId } from "@/lib/dsp/config";
import { isBypassed } from "@/lib/dsp/configUtil";
import { useChain } from "@/lib/state/chainStore";
import { DeplosiveConfirm } from "./DeplosiveConfirm";
import { NoisePrintPanel } from "./NoisePrintPanel";
import { ParamEditor } from "./ParamEditor";

const KIND_LABEL = { native: "OfflineAudioContext", js: "worker DSP", analysis: "analysis" } as const;
const STATUS_STYLE: Record<string, string> = {
  applied: "text-emerald-400",
  bypassed: "text-neutral-500",
  skipped: "text-neutral-400",
  "awaiting-confirmation": "text-amber-400",
  analysis: "text-sky-400",
};

/** One panel: every stage, in chain order, with bypass, rationale, status and parameters. */
export function ChainPanel() {
  const { cfg, bypass, setBypass, setParam, result, analysis, resetConfig } = useChain();
  const [open, setOpen] = useState<StageId | null>(null);
  const reports = new Map(result?.reports.map((r) => [r.id, r]));

  return (
    <section className="rounded-lg border border-neutral-800">
      <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="font-semibold">Chain</h2>
        <button className="text-xs text-neutral-400 underline hover:text-neutral-200" onClick={resetConfig}>
          Reset to defaults
        </button>
      </header>
      <ol>
        {CHAIN_ORDER.map((id, i) => {
          const stage = cfg.stages[id];
          const off = isBypassed(cfg, id, bypass);
          const rep = reports.get(id);
          const status = off ? "bypassed" : rep?.status;
          return (
            <li key={id} className="border-b border-neutral-900 px-3 py-2 last:border-0" data-stage={id}>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 w-5 text-right text-xs text-neutral-600">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={off ? "text-neutral-500 line-through" : "font-medium"}>{stage.label}</span>
                    <span className="rounded bg-neutral-800 px-1.5 text-[10px] text-neutral-400">{KIND_LABEL[STAGE_KIND[id]]}</span>
                    {status && <span className={`text-xs ${STATUS_STYLE[status] ?? ""}`}>{status}</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-neutral-400" data-testid={`why-${id}`}>
                    {stage.rationale}
                  </p>
                  {rep?.note && <p className="mt-0.5 text-xs text-neutral-500">{rep.note}</p>}
                  {rep?.metrics && (
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {Object.entries(rep.metrics)
                        .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(2) : String(v)}`)
                        .join(" · ")}
                    </p>
                  )}
                  {id === "noisePrint" && !off && <div className="mt-2"><NoisePrintPanel /></div>}
                  {id === "clippingCheck" && !off && analysis?.clipping && (
                    <p className={`mt-1 text-xs ${analysis.clipped ? "text-amber-400" : "text-emerald-400"}`}>
                      {analysis.clipped
                        ? `Clipped: ${analysis.clipping.runCount.value} flat-top runs, ${analysis.clipping.trueOverCount.value} true-peak overs.`
                        : "No clipping detected."}
                    </p>
                  )}
                  {id === "deplosive" && !off && <div className="mt-2"><DeplosiveConfirm /></div>}
                  {open === id && (
                    <div className="mt-2 rounded bg-neutral-900/60 p-2">
                      <ParamEditor value={stage.params} path={["stages", id, "params"]} onChange={setParam} />
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <label className="flex cursor-pointer items-center gap-1 text-xs">
                    <input type="checkbox" checked={off} onChange={(e) => setBypass(id, e.target.checked)} aria-label={`Bypass ${stage.label}`} data-testid={`bypass-${id}`} />
                    Bypass
                  </label>
                  <button className="text-xs text-neutral-500 underline hover:text-neutral-300" onClick={() => setOpen(open === id ? null : id)}>
                    {open === id ? "hide" : "params"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
