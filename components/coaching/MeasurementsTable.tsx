import type { Measurement } from "@/lib/decision/evaluate";

const fmt = (v: number, unit: string) => (unit === "ratio" ? (v === 0 ? "0" : v.toPrecision(3)) : v.toFixed(1));

/** The user's own measurements (Phase 1 functions). These render with or without a reference. */
export function MeasurementsTable({ measurements }: { measurements: readonly Measurement[] }) {
  return (
    <table className="w-full text-xs" data-testid="measurements-table">
      <caption className="mb-1 text-left text-neutral-400">Your measurements</caption>
      <tbody>
        {measurements.map((m) => (
          <tr key={m.metricId} className="border-t border-neutral-900" data-metric={m.metricId}>
            <td className="py-1 pr-2 text-neutral-300">{m.label}</td>
            <td className="py-1 text-right tabular-nums">
              {m.reading.status === "ok" ? (
                `${fmt(m.reading.value, m.reading.unit)} ${m.reading.unit}`
              ) : (
                <span className="text-neutral-500" title={m.reading.reason}>
                  unavailable
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
