import { MIX_METRICS, type Template } from "./types";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Throws on a malformed template. Measured values must be finite numbers for known metrics; ids must be unique. */
export function validateTemplate(t: unknown): Template {
  if (!isObj(t)) throw new Error("template: not an object");
  if (t.tier !== "free") throw new Error("template: tier must be 'free'");
  if (t.targetScope !== "full-mix") throw new Error("template: targetScope must be 'full-mix'");
  if (typeof t.id !== "string" || !t.id) throw new Error("template: missing id");
  if (!Array.isArray(t.references) || t.references.length === 0) throw new Error("template: needs references");
  if (!Array.isArray(t.steps) || t.steps.length === 0) throw new Error("template: needs steps");
  if (!Array.isArray(t.unverified)) throw new Error("template: needs an 'unverified' list");

  const refIds = new Set<string>();
  for (const r of t.references as unknown[]) {
    if (!isObj(r) || typeof r.id !== "string" || typeof r.label !== "string") throw new Error("template: bad reference");
    if (refIds.has(r.id)) throw new Error(`template: duplicate reference id ${r.id}`);
    refIds.add(r.id);
    if (typeof r.enabled !== "boolean") throw new Error(`template: reference ${r.id} needs enabled`);
    if (r.measured !== null) {
      if (!isObj(r.measured)) throw new Error(`template: reference ${r.id} measured must be an object or null`);
      for (const [k, v] of Object.entries(r.measured)) {
        if (!(MIX_METRICS as readonly string[]).includes(k)) throw new Error(`template: reference ${r.id} has unknown metric ${k}`);
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`template: reference ${r.id} metric ${k} is not a finite number`);
      }
    }
  }

  const stepIds = new Set<string>();
  for (const s of t.steps as unknown[]) {
    if (!isObj(s) || typeof s.id !== "string" || typeof s.do !== "string") throw new Error("template: bad step");
    if (stepIds.has(s.id)) throw new Error(`template: duplicate step id ${s.id}`);
    stepIds.add(s.id);
    if (s.where !== "app" && s.where !== "bandlab") throw new Error(`template: step ${s.id} where must be app|bandlab`);
    if (s.check !== undefined) {
      if (!Array.isArray(s.check) || s.check.some((m) => !(MIX_METRICS as readonly unknown[]).includes(m)))
        throw new Error(`template: step ${s.id} has an unknown check metric`);
    }
  }
  return t as unknown as Template;
}
