"use client";

import { fingerprint } from "@/lib/storage/idb";
import { configForPreset, getPreset, PRESETS, type PresetId } from "@/lib/presets";
import { useChain } from "@/lib/state/chainStore";

/** Picks the genre chain. Switching resolves a complete config and re-renders; the active preset is always shown. */
export function PresetPicker() {
  const { presetId, switchPreset, cfg, busy, analysis, popDecision } = useChain();
  const active = getPreset(presetId)!;
  const modified = fingerprint(cfg) !== fingerprint(configForPreset(presetId));
  return (
    <section className="space-y-1 rounded-lg border border-neutral-800 p-3" data-testid="preset-section">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Preset</h2>
        <select
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
          value={presetId}
          disabled={busy !== null}
          onChange={(e) => void switchPreset(e.target.value as PresetId)}
          data-testid="preset-picker"
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-emerald-400" data-testid="active-preset">
          Active preset: {active.label}
          {modified ? " (edited)" : ""}
        </span>
      </div>
      <p className="text-xs text-neutral-400">{active.description}</p>
      {analysis && popDecision === "pending" && <p className="text-xs text-amber-400">Confirm or skip the detected pops, then render with this preset.</p>}
      <p className="text-[11px] text-neutral-600">Preset values are authored placeholders, not tuned on real recordings yet.</p>
    </section>
  );
}
