import { validateContext } from "./load";
import type { CoachingCopy, DecisionContext, MetricDef, Rule } from "./types";
import coachingJson from "./coaching.json";
import metricsJson from "./metrics.json";
import tableJson from "./table.json";

/** The shipped metric registry + authored decision table + coaching copy, validated at load (throws on any inconsistency). */
export const DEFAULT_CONTEXT: DecisionContext = validateContext({
  metrics: metricsJson.metrics as MetricDef[],
  rules: tableJson.rules as Rule[],
  coaching: coachingJson.coaching as Record<string, CoachingCopy>,
});
