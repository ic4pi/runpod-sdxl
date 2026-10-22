import { formatDelta, type DeltaRow } from "@/lib/decision/evaluate";

/** Differences from the selected reference. Only deltas are shown; the reference's absolute numbers are never displayed. */
export function DeltaTable({ deltas }: { deltas: readonly DeltaRow[] }) {
  return (
    <table className="w-full text-xs" data-testid="delta-table">
      <caption className="mb-1 text-left text-neutral-400">Difference from the reference</caption>
      <tbody>
        {deltas.map((d) => (
          <tr key={d.metricId} className="border-t border-neutral-900" data-metric={d.metricId}>
            <td className="py-1 pr-2 text-neutral-300">{d.label}</td>
            <td className="py-1 text-right tabular-nums">
              {d.status === "ok" ? (
                <span data-delta={d.delta}>
                  {formatDelta(d.delta, d.deltaUnit)} {d.deltaUnit}
                </span>
              ) : (
                <span className="text-neutral-500" title={d.reason}>
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
