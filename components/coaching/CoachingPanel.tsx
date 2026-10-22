import type { EvaluationResult } from "@/lib/decision/evaluate";
import { DeltaTable } from "./DeltaTable";
import { MeasurementsTable } from "./MeasurementsTable";
import { PlaceholderBanner } from "./PlaceholderBanner";

const SEV_STYLE = { critical: "border-red-700 bg-red-950/40", warn: "border-amber-700 bg-amber-950/30", info: "border-neutral-700 bg-neutral-900" } as const;
const SEV_LABEL = { critical: "Fix first", warn: "Worth fixing", info: "Optional" } as const;

/** Pure presentation of an EvaluationResult. The no-reference text comes from `result.reason` (set in code by evaluate()). */
export function CoachingPanel({ result }: { result: EvaluationResult }) {
  if (result.kind === "no-reference") {
    return (
      <div className="space-y-3">
        <p className="rounded border border-neutral-700 bg-neutral-900 p-3 text-sm text-neutral-300" data-testid="coaching-empty">
          {result.reason}
        </p>
        <MeasurementsTable measurements={result.measurements} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <PlaceholderBanner profile={result.profile} />
      <div>
        <h3 className="mb-1 text-sm font-medium">Coaching vs {result.profile.label}</h3>
        {result.coaching.length === 0 ? (
          <p className="text-xs text-neutral-400" data-testid="coaching-none">
            Nothing is beyond the thresholds for this reference.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="coaching-lines">
            {result.coaching.map((c) => (
              <li key={c.ruleId} className={`rounded border p-2 text-xs ${SEV_STYLE[c.severity]}`} data-testid="coaching-line" data-rule={c.ruleId}>
                <p className="font-medium">
                  {c.title} <span className="ml-1 text-[10px] uppercase text-neutral-400">{SEV_LABEL[c.severity]}</span>
                </p>
                <p className="mt-0.5 text-neutral-300">{c.message}</p>
                <p className="mt-0.5 text-emerald-300">Try: {c.suggestedMove}</p>
              </li>
            ))}
          </ul>
        )}
        {result.notEvaluated.length > 0 && (
          <p className="mt-2 text-xs text-neutral-500" data-testid="coaching-not-evaluated">
            Not checked: {result.notEvaluated.map((n) => `${n.ruleId} (${n.reason})`).join("; ")}
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <DeltaTable deltas={result.deltas} />
        <MeasurementsTable measurements={result.measurements} />
      </div>
    </div>
  );
}
