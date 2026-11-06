import { MIX_METRICS, type MixMetricId, type TasteMetric, type TasteTarget, type Template } from "./types";

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Pure: returns a copy with one reference switched on or off. Unknown id throws. */
export function setReferenceEnabled(t: Template, refId: string, enabled: boolean): Template {
  if (!t.references.some((r) => r.id === refId)) throw new Error(`unknown reference ${refId}`);
  return { ...t, references: t.references.map((r) => (r.id === refId ? { ...r, enabled } : r)) };
}

/** Pure: store a reference's measurements (e.g. from the user's own copy of the song). */
export function setReferenceMeasured(t: Template, refId: string, measured: Partial<Record<MixMetricId, number>>): Template {
  if (!t.references.some((r) => r.id === refId)) throw new Error(`unknown reference ${refId}`);
  return { ...t, references: t.references.map((r) => (r.id === refId ? { ...r, measured } : r)) };
}

/**
 * The taste target = per-metric median, min and max across ENABLED references that have a measurement for that metric.
 * Five songs cannot make a percentile distribution (the stock profiles need N>=200), so a range is reported, not
 * percentiles. A metric no enabled reference has measured is absent: it is not defaulted or guessed.
 */
export function blendTaste(t: Template): TasteTarget {
  const enabled = t.references.filter((r) => r.enabled);
  const used = enabled.filter((r) => r.measured && Object.keys(r.measured).length > 0);
  const awaiting = enabled.filter((r) => !r.measured || Object.keys(r.measured).length === 0).map((r) => r.id);

  const metrics: Partial<Record<MixMetricId, TasteMetric>> = {};
  for (const id of MIX_METRICS) {
    const xs = used.map((r) => r.measured?.[id]).filter((v): v is number => typeof v === "number");
    if (xs.length === 0) continue;
    metrics[id] = { median: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
  }
  const confidence = used.length === 0 ? "none" : used.length < 3 ? "low" : "ok";
  return { metrics, used: used.map((r) => r.id), awaiting, confidence };
}
