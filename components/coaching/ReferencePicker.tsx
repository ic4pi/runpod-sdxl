import type { ReferenceProfile } from "@/lib/decision/types";

export function ReferencePicker({
  profiles,
  value,
  onChange,
}: {
  profiles: readonly ReferenceProfile[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-neutral-400">Reference</span>
      <select
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        data-testid="reference-picker"
      >
        <option value="">None (measurements only)</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
