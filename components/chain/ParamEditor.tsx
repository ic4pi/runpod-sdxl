"use client";

type Path = (string | number)[];

const ENUMS: Record<string, readonly string[]> = {
  thresholdMode: ["relative-to-print", "absolute"],
  oversample: ["none", "2x", "4x"],
  type: ["peaking", "lowshelf", "highshelf"],
};

/** Generic editor for a stage's `params` subtree: every number/boolean/enum leaf becomes an input that writes back to the config. */
export function ParamEditor({ value, path, onChange }: { value: unknown; path: Path; onChange: (path: Path, v: unknown) => void }) {
  if (value === null || typeof value !== "object") {
    return <Leaf value={value} path={path} onChange={onChange} />;
  }
  const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value as object);
  const leaves = entries.filter(([, v]) => v === null || typeof v !== "object");
  const groups = entries.filter(([, v]) => v !== null && typeof v === "object");
  return (
    <div className="space-y-2">
      {leaves.length > 0 && (
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {leaves.map(([k, v]) => (
            <label key={String(k)} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-neutral-400">{String(k)}</span>
              <Leaf value={v} path={[...path, k]} onChange={onChange} />
            </label>
          ))}
        </div>
      )}
      {groups.map(([k, v]) => (
        <fieldset key={String(k)} className="rounded border border-neutral-800 p-2">
          <legend className="px-1 text-xs text-neutral-500">{String(k)}</legend>
          <ParamEditor value={v} path={[...path, k]} onChange={onChange} />
        </fieldset>
      ))}
    </div>
  );
}

function Leaf({ value, path, onChange }: { value: unknown; path: Path; onChange: (path: Path, v: unknown) => void }) {
  const key = String(path[path.length - 1]);
  const cls = "w-28 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-right text-xs";
  if (typeof value === "boolean") {
    return <input type="checkbox" checked={value} onChange={(e) => onChange(path, e.target.checked)} />;
  }
  if (typeof value === "number") {
    return (
      <input
        type="number"
        step="any"
        className={cls}
        value={value}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) onChange(path, n);
        }}
      />
    );
  }
  if (typeof value === "string" && ENUMS[key]) {
    return (
      <select className={cls} value={value} onChange={(e) => onChange(path, e.target.value)}>
        {ENUMS[key]!.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  }
  return <span className="text-xs text-neutral-300">{String(value)}</span>;
}
