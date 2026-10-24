/**
 * scripts/smoke-pro-model.mjs must FAIL LOUDLY. It is run for real (child process) against a local STUB that speaks the Anthropic wire format.
 * This verifies the script's checks, NOT the real model: no real API call is made here.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRO_CONFIG } from "../../lib/pro/config";
import { tier1FallbackItems } from "../../lib/pro/findings";
import { THREE_FINDINGS } from "./helpers";

const p = THREE_FINDINGS();
let mode = "good";
let url = "";
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.url?.endsWith("/chat/completions")) {
      const body = JSON.stringify({ items: tier1FallbackItems(p) });
      const echoed = mode === "or-wrong-model" ? "openai/gpt-5" : mode === "or-dated" ? "anthropic/claude-haiku-5-5-20261001" : "anthropic/claude-haiku-5-5";
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "gen-1", model: echoed, choices: [{ finish_reason: "stop", message: { role: "assistant", content: body } }], usage: { prompt_tokens: 1500, completion_tokens: 400 } }));
    }
    if (mode === "http500") return void res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }));
    const items = tier1FallbackItems(p).map((i) => ({ ...i }));
    let text = JSON.stringify({ items });
    let model: string = PRO_CONFIG.model;
    if (mode === "wrong-model") model = "claude-sonnet-5-5";
    if (mode === "empty") text = "";
    if (mode === "bad-schema") text = JSON.stringify({ items: [{ coaching_id: "nope" }] });
    if (mode === "not-json") text = "Sure! Here you go.";
    if (mode === "hallucinated-number") (items[1]!.explanation += " That is 777 dB too much."), (text = JSON.stringify({ items }));
    if (mode === "unpinned-move") (items[1]!.suggested_move = "Delete the vocal."), (text = JSON.stringify({ items }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1234, output_tokens: 321 } }));
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));

// async (not spawnSync): the stub server lives in THIS process, so the event loop must stay free to answer the child
const run = (m: string, env: Record<string, string> | null = { ANTHROPIC_API_KEY: "sk-stub", ANTHROPIC_BASE_URL: url }) => {
  mode = m;
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile("npx", ["tsx", "scripts/smoke-pro-model.mjs"], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "", ...(env ?? {}) }, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}\n${stderr}` });
    });
  });
};

describe("smoke-pro-model.mjs (against a stub, not the real API)", () => {
  it("passes only when the model id matches, output is non-empty, schema-valid and validator-clean; prints real token counts and latency", async () => {
    const r = await run("good");
    expect(r.code).toBe(0);
    expect(r.out).toContain("SMOKE PASSED");
    expect(r.out).toMatch(/model echoed by API\s*: claude-haiku-5-5/);
    expect(r.out).toMatch(/prompt tokens \(real\)\s*: 1234/);
    expect(r.out).toMatch(/completion tokens \(real\): 321/);
    expect(r.out).toMatch(/latency\s*: \d+ ms/);
    expect(r.out).toMatch(/schema respected\s*: true/);
    expect(r.out).toMatch(/passed validate.ts\s*: true/);
  }, 90_000);

  for (const [mode, expected] of [
    ["wrong-model", /WRONG MODEL/],
    ["empty", /EMPTY OUTPUT/],
    ["bad-schema", /SCHEMA VIOLATION/],
    ["not-json", /SCHEMA VIOLATION: output is not valid JSON/],
    ["hallucinated-number", /VALIDATOR REJECTED[\s\S]*number/],
    ["unpinned-move", /VALIDATOR REJECTED[\s\S]*pinned-move/],
    ["http500", /API call failed/],
  ] as const) {
    it(`FAILS with a non-zero exit on: ${mode}`, async () => {
      const r = await run(mode);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(expected);
      expect(r.out).not.toContain("SMOKE PASSED");
    }, 90_000);
  }

  const OR = (extra: Record<string, string> = {}) => ({ OPENROUTER_API_KEY: "sk-or-stub", OPENROUTER_MODEL: "anthropic/claude-haiku-5-5", OPENROUTER_BASE_URL: `${url}/api/v1`, ...extra });
  it("OpenRouter: passes through the same checks (provider printed, token counts real, dated slug of the requested model accepted)", async () => {
    for (const m of ["or-ok", "or-dated"]) {
      const r = await run(m, OR());
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/provider\s*: openrouter/);
      expect(r.out).toMatch(/prompt tokens \(real\)\s*: 1500/);
      expect(r.out).toContain("SMOKE PASSED");
    }
  }, 90_000);
  it("OpenRouter: FAILS on a different model than requested, and exits 2 when OPENROUTER_MODEL is missing", async () => {
    const wrong = await run("or-wrong-model", OR());
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/WRONG MODEL/);
    const missing = await run("or-ok", { OPENROUTER_API_KEY: "sk-or-stub", OPENROUTER_BASE_URL: `${url}/api/v1` });
    expect(missing.code).toBe(2);
    expect(missing.out).toMatch(/OPENROUTER_MODEL is not set/);
  }, 90_000);

  it("with no API key: exit 2, says nothing was verified, and never prints a pass", async () => {
    const r = await run("good", null);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Nothing was called; nothing is verified/);
    expect(r.out).not.toContain("SMOKE PASSED");
  }, 90_000);
});
