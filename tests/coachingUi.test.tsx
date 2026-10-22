/** UI rendering tests. INPUTS ARE SYNTHETIC METRIC VALUES (invented placeholder profiles); no audio. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoachingPanel } from "../components/coaching/CoachingPanel";
import { DEFAULT_CONTEXT } from "../lib/decision/default";
import { evaluate, NO_REFERENCE_REASON, profileValueAtPct } from "../lib/decision/evaluate";
import type { MetricReading, UserMetrics } from "../lib/decision/types";
import { PROFILES } from "../lib/reference/profiles";

const trap = PROFILES.find((p) => p.id === "trap")!;
const metrics: UserMetrics = Object.fromEntries(
  DEFAULT_CONTEXT.metrics.map((m) => [m.id, { status: "ok", value: profileValueAtPct(trap, m.id, 50) + 0.1, unit: m.unit } as MetricReading]),
);
const clippy: UserMetrics = { ...metrics, clipped_sample_ratio: { status: "ok", value: 0.01, unit: "ratio" } };

describe("coaching panel", () => {
  it("no reference: renders the empty-state STRING (not just a panel), the measurements, and no advice", () => {
    const html = renderToStaticMarkup(<CoachingPanel result={evaluate(null, metrics)} />);
    expect(html).toContain('data-testid="coaching-empty"');
    expect(html).toContain(NO_REFERENCE_REASON);
    expect(html).toContain("Pick a reference profile");
    expect(html).toContain('data-testid="measurements-table"');
    expect(html).not.toContain("coaching-line");
    expect(html).not.toContain("coaching-lines");
    expect(html).not.toContain("delta-table");
    expect(html).not.toContain("placeholder-banner");
  });

  it("with a reference: placeholder banner, delta table, and a coaching line with its suggested move", () => {
    const html = renderToStaticMarkup(<CoachingPanel result={evaluate(trap, clippy)} />);
    expect(html).not.toContain('data-testid="coaching-empty"');
    expect(html).toContain('data-testid="placeholder-banner"');
    expect(html).toContain("Placeholder reference: not measured data.");
    expect(html).toContain('data-testid="delta-table"');
    expect(html).toContain('data-rule="clipping_present"');
    expect(html).toContain("Re-record with the input gain lower.");
  });

  it("with a reference and nothing beyond thresholds: says so", () => {
    const clean: UserMetrics = { ...metrics, clipped_sample_ratio: { status: "ok", value: 0, unit: "ratio" } };
    const html = renderToStaticMarkup(<CoachingPanel result={evaluate(trap, clean)} />);
    expect(html).toContain("Nothing is beyond the thresholds");
    expect(html).not.toContain("coaching-line");
  });
});
