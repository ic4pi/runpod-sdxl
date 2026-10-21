import type { ChainConfig, StageId } from "./config";

export const cloneConfig = (c: ChainConfig): ChainConfig => structuredClone(c);

/** Immutable set of a leaf by path, e.g. setByPath(cfg, ["stages","hpf","params","frequencyHz"], 80). */
export function setByPath<T>(obj: T, path: readonly (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const copy: any = Array.isArray(obj) ? [...(obj as any)] : { ...(obj as any) };
  copy[head as any] = setByPath(copy[head as any], rest, value);
  return copy;
}

/** Bypass map as the UI/runtime sees it: defaults from config, overridden by the user. */
export type BypassMap = Partial<Record<StageId, boolean>>;

export function isBypassed(cfg: ChainConfig, id: StageId, overrides?: BypassMap): boolean {
  return overrides?.[id] ?? cfg.stages[id].bypass;
}
