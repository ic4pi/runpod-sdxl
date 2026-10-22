/** Preset tests. No audio: configs only. */
import { describe, expect, it } from "vitest";
import { DEFAULT_CHAIN_CONFIG, type ChainConfig } from "../lib/dsp/config";
import { cloneConfig } from "../lib/dsp/configUtil";
import { configForPreset, deepMerge, DEFAULT_PRESET_ID, getPreset, PRESETS } from "../lib/presets";

type Leaf = { path: string; value: unknown };

/** Every leaf (number/string/boolean/null-or-undefined/array element) of a value, with its path. */
function leaves(v: unknown, path = "$"): Leaf[] {
  if (Array.isArray(v)) return v.length === 0 ? [{ path: `${path}[]`, value: v }] : v.flatMap((x, i) => leaves(x, `${path}[${i}]`));
  if (v !== null && typeof v === "object") return Object.entries(v as object).flatMap(([k, x]) => leaves(x, `${path}.${k}`));
  return [{ path, value: v }];
}
const kind = (v: unknown) => (typeof v === "number" ? (Number.isFinite(v) ? "number" : "non-finite") : typeof v);

describe("presets resolve to a COMPLETE config", () => {
  it("ships 3-5 genre presets plus the neutral baseline, ids unique", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["trap", "boom-bap", "drill"]));
    expect(PRESETS.filter((p) => p.id !== "neutral").length).toBeGreaterThanOrEqual(3);
    expect(PRESETS.filter((p) => p.id !== "neutral").length).toBeLessThanOrEqual(5);
    expect(getPreset(DEFAULT_PRESET_ID)).not.toBeNull();
  });

  const defaultLeaves = leaves(DEFAULT_CHAIN_CONFIG);

  for (const preset of PRESETS) {
    describe(preset.id, () => {
      const resolved = configForPreset(preset.id);
      const resolvedLeaves = leaves(resolved);

      it("every leaf is defined, finite and has the same type as the default's leaf (no undefined leaves)", () => {
        const byPath = new Map(resolvedLeaves.map((l) => [l.path, l.value]));
        const problems: string[] = [];
        for (const d of defaultLeaves) {
          if (!byPath.has(d.path)) {
            // array elements may legitimately differ in count (EQ bands); the array itself must still exist and have leaves
            if (!/\[\d+\]/.test(d.path)) problems.push(`missing: ${d.path}`);
            continue;
          }
          const v = byPath.get(d.path);
          if (v === undefined) problems.push(`undefined: ${d.path}`);
          else if (kind(v) !== kind(d.value)) problems.push(`type ${kind(v)} != ${kind(d.value)}: ${d.path}`);
        }
        for (const l of resolvedLeaves) {
          if (l.value === undefined || l.value === null) problems.push(`undefined/null leaf: ${l.path}`);
          if (kind(l.value) === "non-finite") problems.push(`non-finite: ${l.path}`);
        }
        expect(problems).toEqual([]);
        expect(resolvedLeaves.length).toBeGreaterThan(150);
      });

      it("has exactly the default's keys at every object level (nothing added, nothing dropped)", () => {
        const keyset = (v: unknown, path = "$"): string[] =>
          Array.isArray(v) ? v.flatMap((x, i) => keyset(x, `${path}[${i}]`)) : v && typeof v === "object"
            ? Object.entries(v).flatMap(([k, x]) => [`${path}.${k}`, ...keyset(x, `${path}.${k}`)])
            : [];
        const strip = (s: string[]) => s.map((k) => k.replace(/\[\d+\]/g, "[]")).filter((k, i, a) => a.indexOf(k) === i).sort();
        expect(strip(keyset(resolved))).toEqual(strip(keyset(DEFAULT_CHAIN_CONFIG)));
      });

      it("is an independent copy: mutating it never touches the defaults or other presets", () => {
        const a = configForPreset(preset.id);
        a.stages.hpf.params.frequencyHz = 12345;
        a.stages.eq.params = { bands: [] };
        expect(configForPreset(preset.id).stages.hpf.params.frequencyHz).toBe(resolved.stages.hpf.params.frequencyHz);
        expect(DEFAULT_CHAIN_CONFIG.stages.hpf.params.frequencyHz).toBe(70);
      });

      it("never changes what analysis reads (clipping check, noise print, pop detection), so switching presets keeps the analysis valid", () => {
        expect(resolved.stages.clippingCheck).toEqual(DEFAULT_CHAIN_CONFIG.stages.clippingCheck);
        expect(resolved.stages.noisePrint).toEqual(DEFAULT_CHAIN_CONFIG.stages.noisePrint);
        expect(resolved.stages.deplosive.params.detect).toEqual(DEFAULT_CHAIN_CONFIG.stages.deplosive.params.detect);
        expect(resolved.internalSampleRate).toBe(DEFAULT_CHAIN_CONFIG.internalSampleRate);
        expect(resolved.export).toEqual(DEFAULT_CHAIN_CONFIG.export); // export target/ceiling are not genre-tunable
        expect(resolved.storage).toEqual(DEFAULT_CHAIN_CONFIG.storage);
        expect(resolved.stages.limiter).toEqual(DEFAULT_CHAIN_CONFIG.stages.limiter);
      });

      it("carries a description and the calibration note", () => {
        expect(preset.description.length).toBeGreaterThan(20);
        expect(preset.calibration).toMatch(/^TODO: CALIBRATE — corpus: N>=\d+/);
      });
    });
  }

  it("the neutral preset is exactly the default config", () => {
    expect(configForPreset("neutral")).toEqual(DEFAULT_CHAIN_CONFIG);
  });

  it("genre presets really differ from neutral and from each other", () => {
    const sig = (c: ChainConfig) => JSON.stringify(c.stages);
    const sigs = PRESETS.map((p) => sig(configForPreset(p.id)));
    expect(new Set(sigs).size).toBe(PRESETS.length);
  });

  it("an unknown preset id throws; deepMerge replaces arrays and ignores undefined", () => {
    expect(() => configForPreset("vibes")).toThrow(/Unknown preset/);
    expect(deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [9], b: { c: undefined, d: 3 } })).toEqual({ a: [9], b: { c: 1, d: 3 } });
  });

  it("a deliberately broken preset WOULD be caught by the completeness check", () => {
    const broken = cloneConfig(DEFAULT_CHAIN_CONFIG) as unknown as Record<string, unknown>;
    (broken.stages as Record<string, unknown>).hpf = { label: "x", rationale: "y", bypass: false, params: { frequencyHz: undefined, qs: [0.5] } };
    const bad = leaves(broken).filter((l) => l.value === undefined);
    expect(bad.map((l) => l.path)).toContain("$.stages.hpf.params.frequencyHz");
  });
});
