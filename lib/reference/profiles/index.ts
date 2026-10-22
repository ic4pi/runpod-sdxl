import metricsJson from "../../decision/metrics.json";
import { validateProfile } from "../../decision/load";
import type { MetricDef, ReferenceProfile } from "../../decision/types";
import boomBap from "./boom-bap.json";
import drill from "./drill.json";
import melodic from "./melodic-rap.json";
import trap from "./trap.json";

const metricIds = (metricsJson.metrics as MetricDef[]).map((m) => m.id);

/** Bundled stock profiles. Validated at load: a profile that lacks `_placeholder`/`_basis` or any metric throws. */
export const PROFILES: readonly ReferenceProfile[] = [trap, boomBap, drill, melodic].map((p) =>
  validateProfile(p as unknown as ReferenceProfile, metricIds),
);

export const getProfile = (id: string): ReferenceProfile | null => PROFILES.find((p) => p.id === id) ?? null;
