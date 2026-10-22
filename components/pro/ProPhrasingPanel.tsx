"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PRO_CONFIG } from "@/lib/pro/config";
import { evaluate } from "@/lib/decision/evaluate";
import { buildPhrasingPayload } from "@/lib/pro/findings";
import { getProKey, requestPhrasing, setProKey, type ClientResult } from "@/lib/pro/client";
import { getProfile } from "@/lib/reference/profiles";
import { useCoaching } from "@/lib/state/coachingStore";
import { openStorage, type Storage } from "@/lib/storage/idb";
import { DEFAULT_CHAIN_CONFIG } from "@/lib/dsp/config";

const SOURCE_LABEL = {
  llm: "Reworded by AI. Every number was checked against your measurements.",
  cache: "Reworded by AI (saved copy, no new request).",
  "tier1-fallback": "Standard text",
} as const;

/** Pro: rewords the Free tier's coaching. It adds no findings and no numbers; Free coaching above is complete without it. */
export function ProPhrasingPanel() {
  const { metrics, profileId } = useCoaching();
  const [storage, setStorage] = useState<Storage | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<ClientResult | null>(null);
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    openStorage({ maxSessions: DEFAULT_CHAIN_CONFIG.storage.maxSessions })
      .then(async (s) => {
        setStorage(s);
        setHasKey(!!(await getProKey(s)));
      })
      .catch(() => setStorage(null));
  }, []);

  const build = useMemo(() => {
    if (!metrics || !profileId) return { ok: false as const, reason: "no-reference" as const };
    return buildPhrasingPayload(evaluate(getProfile(profileId), metrics));
  }, [metrics, profileId]);

  useEffect(() => setOut(null), [metrics, profileId]);

  const canRun = build.ok && storage && hasKey && !busy;
  return (
    <section className="space-y-3 rounded-lg border border-violet-900 p-3" data-testid="pro-section">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Pro: reword my coaching</h2>
        <span className="rounded bg-violet-900 px-1.5 text-[10px] uppercase">Pro</span>
      </div>
      <p className="text-xs text-neutral-400">
        Optional. A language model rewrites the advice above in plainer words. It can only restate what the measurements already found: it cannot add findings, and any number it uses
        is checked against your measurements before you see it. If anything looks wrong, you get the standard text instead.
      </p>

      {storage && !hasKey && (
        <form
          className="flex flex-wrap items-center gap-2 text-xs"
          onSubmit={async (e) => {
            e.preventDefault();
            if (keyDraft.trim().length >= 8) {
              await setProKey(storage, keyDraft.trim());
              setHasKey(true);
              setKeyDraft("");
            }
          }}
        >
          <input
            className="w-64 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            type="password"
            placeholder="Pro key"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            data-testid="pro-key-input"
          />
          <button className="rounded bg-violet-700 px-2 py-1 hover:bg-violet-600" data-testid="pro-key-save">
            Save key
          </button>
          <span className="text-neutral-500">Without a key the standard text is shown and no request is made.</span>
        </form>
      )}
      {hasKey && storage && (
        <button className="text-xs text-neutral-500 underline" onClick={async () => { await setProKey(storage, null); setHasKey(false); setOut(null); }}>
          Remove Pro key
        </button>
      )}

      {!build.ok && (
        <p className="text-xs text-neutral-500" data-testid="pro-unavailable">
          {build.reason === "no-reference" ? "Select a reference above first: there is no coaching to reword without one." : "Nothing beyond the thresholds, so there is nothing to reword."}
        </p>
      )}

      {build.ok && (
        <div>
          <button
            className="rounded bg-violet-700 px-3 py-1 font-medium hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canRun}
            data-testid="pro-reword"
            onClick={async () => {
              if (!storage) return;
              setBusy(true);
              setOut(await requestPhrasing({ payload: build.payload, storage }));
              setBusy(false);
            }}
          >
            {busy ? "Rewording…" : "Reword with AI"}
          </button>
          {!hasKey && <span className="ml-2 text-xs text-neutral-500">Enter a Pro key to enable.</span>}
        </div>
      )}

      {out && (
        <div className="space-y-2" data-testid="pro-result" data-source={out.source}>
          <p className={`text-xs ${out.source === "tier1-fallback" ? "text-amber-400" : "text-emerald-400"}`} data-testid="pro-source">
            {SOURCE_LABEL[out.source]}
            {out.fallbackReason ? ` ${out.fallbackReason}` : ""}
          </p>
          <ul className="space-y-2">
            {out.items.map((it) => (
              <li key={it.coaching_id} className="rounded border border-neutral-700 p-2 text-xs" data-testid="pro-item" data-coaching={it.coaching_id}>
                <p className="font-medium">{it.headline}</p>
                <p className="mt-0.5 text-neutral-300">{it.explanation}</p>
                <p className="mt-0.5 text-emerald-300">Try: {it.suggested_move}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[11px] text-neutral-600">At most {1 + PRO_CONFIG.maxRetries} model attempts per request; identical results are saved on this device and cost nothing to repeat.</p>
    </section>
  );
}
