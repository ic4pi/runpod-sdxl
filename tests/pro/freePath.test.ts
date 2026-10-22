/** Free/Pro boundary: build-time checker behaviour + zero fetch on the Free code path. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs script
import { checkBoundary, PRO_DIRS } from "../../scripts/check-pro-boundary.mjs";
import { DEFAULT_CONTEXT } from "../../lib/decision/default";
import { evaluate } from "../../lib/decision/evaluate";
import { metricsTripping, trap } from "./helpers";

const ROOT = path.resolve(__dirname, "../..");

describe("Free path never reaches Pro", () => {
  it("the real repo has zero boundary violations", () => {
    expect(checkBoundary(ROOT)).toEqual([]);
  });

  it("the Free path (evaluate -> coaching, the full Tier 1 pipeline) makes ZERO fetch calls", () => {
    const spy = vi.fn();
    const xhr = vi.fn();
    vi.stubGlobal("fetch", spy);
    vi.stubGlobal("XMLHttpRequest", xhr);
    vi.stubGlobal("WebSocket", xhr);
    vi.stubGlobal("navigator", { ...(globalThis.navigator ?? {}), sendBeacon: xhr });
    try {
      const everything = Object.fromEntries(DEFAULT_CONTEXT.rules.map((r) => [r.metric, r.direction === "above" ? 1e3 : -1e3]));
      const r = evaluate(trap, metricsTripping(everything));
      expect(r.kind).toBe("evaluated");
      if (r.kind === "evaluated") expect(r.coaching.length).toBeGreaterThan(0); // real Tier 1 output was produced
      evaluate(null, metricsTripping({})); // no-reference path too
      expect(spy).not.toHaveBeenCalled();
      expect(xhr).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Free modules contain no phrasing endpoint, Pro import, SDK or zod (static scan of the real tree)", () => {
    for (const f of ["lib/decision/evaluate.ts", "app/repair/page.tsx", "app/repair/layout.tsx"]) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).not.toContain("/api/phrasing");
      expect(src, f).not.toMatch(/lib\/pro|components\/pro|@anthropic-ai|from "zod"/);
    }
  });

  const fixture = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "boundary-"));
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), c);
    }
    return dir;
  };

  it("CHECKER FAILS THE BUILD when a Free file imports Pro (every import form), the SDK, zod, or names the endpoint", () => {
    const bad: Record<string, string> = {
      "components/coaching/a.tsx": `import { x } from "../../lib/pro/client";`,
      "components/coaching/b.tsx": `import { x } from "@/lib/pro/findings";`,
      "lib/decision/c.ts": `export * from "../pro/schema";`,
      "lib/decision/d.ts": `const m = await import("../pro/validate");`,
      "lib/decision/e.ts": `const m = require("../pro/hash");`,
      "lib/decision/f.ts": `import Anthropic from "@anthropic-ai/sdk";`,
      "lib/decision/g.ts": `import { z } from "zod";`,
      "lib/decision/h.ts": `fetch("/api/phrasing");`,
      "components/coaching/i.tsx": `import P from "@/components/pro/ProPhrasingPanel";`,
      "lib/pro/ok.ts": `import { z } from "zod"; fetch("/api/phrasing");`, // inside Pro: allowed
    };
    const problems: string[] = checkBoundary(fixture(bad));
    for (const f of Object.keys(bad).filter((k) => !k.startsWith("lib/pro/"))) expect(problems.some((x) => x.startsWith(f + ":")), f).toBe(true);
    expect(problems.some((x) => x.startsWith("lib/pro/"))).toBe(false);
  });

  it("checker passes a clean tree, and PRO_DIRS covers lib, components, route and the parallel slot", () => {
    expect(checkBoundary(fixture({ "lib/a.ts": `import { b } from "./b";`, "lib/b.ts": `export const b = 1;` }))).toEqual([]);
    expect([...PRO_DIRS].sort()).toEqual(["app/api/phrasing", "app/repair/@pro", "components/pro", "lib/pro"]);
  });

  it("the check runs on every build (prebuild) and as its own script", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.prebuild).toContain("check-pro-boundary");
    expect(pkg.scripts["check:boundary"]).toContain("check-pro-boundary");
  });

  it("the Pro route runs on Node (Next 16 default: no edge export) and lib/pro has no Node-only imports (client.ts runs in the browser)", () => {
    const route = readFileSync(path.join(ROOT, "app/api/phrasing/route.ts"), "utf8");
    expect(route).not.toMatch(/runtime\s*=\s*["']edge["']/);
    expect(route).not.toMatch(/export const runtime/); // Next 16.4 docs: nodejs is the default; remove the export
    expect(route).toMatch(/export const maxDuration = 30/);
    for (const f of ["client", "config", "findings", "handler", "hash", "limits", "llm", "prompt", "schema", "validate", "auth"]) {
      expect(readFileSync(path.join(ROOT, "lib/pro", `${f}.ts`), "utf8"), f).not.toMatch(/from "node:|require\("node:|from "(fs|path|crypto)"/);
    }
  });
});
