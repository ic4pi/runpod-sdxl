"use client";

import { useEffect, useMemo } from "react";
import { evaluate } from "@/lib/decision/evaluate";
import { getProfile, PROFILES } from "@/lib/reference/profiles";
import { useChain } from "@/lib/state/chainStore";
import { useCoaching } from "@/lib/state/coachingStore";
import { CoachingPanel } from "./CoachingPanel";
import { ReferencePicker } from "./ReferencePicker";

/** Free coaching: measures the track with Phase 1, compares to the chosen reference, shows deltas and advice. No LLM. */
export function CoachingSection() {
  const analysis = useChain((s) => s.analysis);
  const processed = useChain((s) => s.result?.processed ?? null);
  const { profileId, setProfile, target, setTarget, metrics, busy, error, measure } = useCoaching();

  useEffect(() => {
    void measure();
  }, [analysis, processed, target]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = useMemo(() => (metrics ? evaluate(profileId ? getProfile(profileId) : null, metrics) : null), [metrics, profileId]);
  if (!analysis) return null;

  return (
    <section className="space-y-3 rounded-lg border border-neutral-800 p-3" data-testid="coaching-section">
      <div className="flex flex-wrap items-center gap-4">
        <h2 className="font-semibold">Coaching</h2>
        <ReferencePicker profiles={PROFILES} value={profileId} onChange={setProfile} />
        <label className="flex items-center gap-2 text-sm">
          <span className="text-neutral-400">Measure</span>
          <select
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            value={target}
            onChange={(e) => setTarget(e.target.value as "original" | "processed")}
            data-testid="measure-target"
          >
            <option value="original">Original</option>
            <option value="processed" disabled={!processed}>
              Processed{processed ? "" : " (render first)"}
            </option>
          </select>
        </label>
        {busy && <span className="text-xs text-amber-400">Measuring...</span>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result ? <CoachingPanel result={result} /> : !error && <p className="text-xs text-neutral-500">Measuring...</p>}
    </section>
  );
}
