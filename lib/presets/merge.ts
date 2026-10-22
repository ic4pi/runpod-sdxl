import { DEFAULT_CHAIN_CONFIG, type ChainConfig } from "../dsp/config";
import { cloneConfig } from "../dsp/configUtil";
import type { DeepPartial, Preset } from "./types";

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge of `patch` over `base`. Objects merge key by key; arrays and scalars replace. `undefined` in the patch is ignored. */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = deepMerge(out[k], v as never);
  }
  return out as T;
}

/** A complete, independent ChainConfig: the preset's overrides merged over a deep clone of the defaults. */
export function resolvePreset(preset: Preset): ChainConfig {
  return deepMerge<ChainConfig>(cloneConfig(DEFAULT_CHAIN_CONFIG), preset.overrides);
}
