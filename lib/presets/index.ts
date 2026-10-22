import type { ChainConfig } from "../dsp/config";
import { boomBap } from "./boomBap";
import { drill } from "./drill";
import { melodicRap } from "./melodicRap";
import { resolvePreset } from "./merge";
import { neutral } from "./neutral";
import { trap } from "./trap";
import type { Preset, PresetId } from "./types";

export type { Preset, PresetId } from "./types";
export { deepMerge, resolvePreset } from "./merge";

/** Authored genre chains (rule 7). Order is the picker order. */
export const PRESETS: readonly Preset[] = [neutral, trap, boomBap, drill, melodicRap];
export const DEFAULT_PRESET_ID: PresetId = "neutral";

export const getPreset = (id: string): Preset | null => PRESETS.find((p) => p.id === id) ?? null;

/** Fresh, complete config for a preset id. Throws on an unknown id. */
export function configForPreset(id: string): ChainConfig {
  const p = getPreset(id);
  if (!p) throw new Error(`Unknown preset '${id}'.`);
  return resolvePreset(p);
}
