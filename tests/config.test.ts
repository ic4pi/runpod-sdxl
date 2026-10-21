import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHAIN_ORDER, DEFAULT_CHAIN_CONFIG, STAGE_KIND } from "../lib/dsp/config";
import { isBypassed } from "../lib/dsp/configUtil";

describe("chain config", () => {
  it("fixed chain order (rule 5, with the analysis-only noise print and the soft gate in the NR slot)", () => {
    expect([...CHAIN_ORDER]).toEqual([
      "clippingCheck", "noisePrint", "hpf", "noiseReduction", "expander", "deplosive", "deess",
      "eq", "compressor", "saturation", "space", "limiter",
    ]);
  });

  it("de-ess before compression; limiter last; EQ before compression", () => {
    const at = (id: (typeof CHAIN_ORDER)[number]) => CHAIN_ORDER.indexOf(id);
    expect(at("deess")).toBeLessThan(at("compressor"));
    expect(at("eq")).toBeLessThan(at("compressor"));
    expect(at("limiter")).toBe(CHAIN_ORDER.length - 1);
    expect(at("noiseReduction")).toBeLessThan(at("deplosive"));
  });

  it("every stage has a label, a non-empty rationale, a bypass default, params and a kind", () => {
    for (const id of CHAIN_ORDER) {
      const s = DEFAULT_CHAIN_CONFIG.stages[id];
      expect(s.label.length, id).toBeGreaterThanOrEqual(2);
      expect(s.rationale.length, id).toBeGreaterThan(30);
      expect(typeof s.bypass).toBe("boolean");
      expect(s.params).toBeTruthy();
      expect(["native", "js", "analysis"]).toContain(STAGE_KIND[id]);
    }
  });

  it("bypass overrides win over config defaults", () => {
    expect(isBypassed(DEFAULT_CHAIN_CONFIG, "hpf")).toBe(false);
    expect(isBypassed(DEFAULT_CHAIN_CONFIG, "hpf", { hpf: true })).toBe(true);
  });

  it("the gate is a soft expander: finite floor, non-zero range, hold and slow release", () => {
    const p = DEFAULT_CHAIN_CONFIG.stages.expander.params;
    expect(p.rangeDb).toBeLessThan(0);
    expect(p.rangeDb).toBeGreaterThan(-40);
    expect(p.ratio).toBeGreaterThan(1);
    expect(p.ratio).toBeLessThanOrEqual(3);
    expect(p.holdMs).toBeGreaterThan(0);
    expect(p.releaseMs).toBeGreaterThan(p.attackMs);
  });
});

describe("zero hardcoded tuning numbers in stage files", () => {
  const dir = path.join(__dirname, "..", "lib", "dsp", "chain");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !["types.ts", "chainProtocol.ts"].includes(f));
  // identities / unit conversions / array arithmetic only
  const ALLOWED = new Set(["0", "1", "2", "3", "4", "10", "20", "1000", "0.5", "1e-12", "1e-24", "1e-30", "1e-7", "1e-9"]);

  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');

  for (const f of files) {
    it(f, () => {
      const code = strip(readFileSync(path.join(dir, f), "utf8"));
      const bad = new Set<string>();
      for (const m of code.matchAll(/(?<![\w.$])(\d+\.?\d*(?:e-?\d+)?)(?![\w])/gi)) {
        if (!ALLOWED.has(m[1]!)) bad.add(m[1]!);
      }
      expect([...bad], `numeric literals in ${f}`).toEqual([]);
    });
  }
});
