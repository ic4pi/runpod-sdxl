/** Anthropic models through OpenRouter. fetch is a SCRIPTED FAKE: this verifies our request/response handling against OpenRouter's DOCUMENTED API, not the real service. */
import { describe, expect, it } from "vitest";
import { tier1FallbackItems } from "../../lib/pro/findings";
import { LlmError } from "../../lib/pro/llm";
import { createOpenRouterLlm } from "../../lib/pro/openrouter";
import { chooseLlm } from "../../lib/pro/provider";
import { SYSTEM_PROMPT } from "../../lib/pro/prompt";
import { TtlLru } from "../../lib/pro/limits";
import type { PhrasingResult } from "../../lib/pro/schema";
import { setup } from "./handlerHarness";
import { THREE_FINDINGS } from "./helpers";

const p = THREE_FINDINGS();
const SLUG = "anthropic/claude-haiku-5-5";
const goodText = JSON.stringify({ items: tier1FallbackItems(p) });
const ok = (over: Record<string, unknown> = {}) => new Response(JSON.stringify({ id: "gen-1", model: SLUG, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: goodText } }], usage: { prompt_tokens: 1500, completion_tokens: 400 }, ...over }), { status: 200 });
const err = (status: number, message = "nope") => new Response(JSON.stringify({ error: { code: status, message } }), { status });

function client(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit; body: any }[] = [];
  const fetchImpl: typeof fetch = async (u, init) => {
    seen.push({ url: String(u), init: init!, body: JSON.parse(String(init!.body)) });
    return handler(String(u), init!, seen.length);
  };
  return { seen, llm: createOpenRouterLlm({ apiKey: "sk-or-test", model: SLUG, referer: "https://example.app", title: "Vocal Repair", fetchImpl }) };
}
const call = (llm: ReturnType<typeof client>["llm"]) => llm.complete({ system: SYSTEM_PROMPT, messages: [{ role: "user", content: "hi" }], signal: new AbortController().signal });
const rejection = async (pr: Promise<unknown>) => pr.then(() => null, (e) => e as LlmError);

describe("request shape (OpenRouter's documented chat-completions API)", () => {
  it("POST /chat/completions with Bearer key, the model slug, system message first, strict json_schema, require_parameters, attribution headers", async () => {
    const { seen, llm } = client(() => ok());
    await call(llm);
    const r = seen[0]!;
    expect(r.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const h = r.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer sk-or-test");
    expect(h["http-referer"]).toBe("https://example.app");
    expect(h["x-title"]).toBe("Vocal Repair");
    expect(r.body.model).toBe(SLUG);
    expect(r.body.messages).toEqual([{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "hi" }]);
    expect(r.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "phrasing", strict: true } });
    expect(r.body.provider).toEqual({ require_parameters: true });
    expect(r.body.max_tokens).toBe(4096);
  });

  it("the schema keeps structure and drops value-constraint keywords some providers reject (our validator enforces them anyway)", async () => {
    const { seen, llm } = client(() => ok());
    await call(llm);
    const schema = seen[0]!.body.response_format.json_schema.schema;
    const flat = JSON.stringify(schema);
    for (const k of ["enum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "$schema"]) expect(flat, k).not.toContain(`"${k}"`);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["items"]);
    expect(schema.properties.items.items.required.sort()).toEqual(["coaching_id", "explanation", "headline", "suggested_move"]);
    expect(schema.properties.items.items.additionalProperties).toBe(false);
  });

  it("base URL is configurable (and a trailing slash is fine)", async () => {
    const seen: string[] = [];
    const llm = createOpenRouterLlm({ apiKey: "k", model: SLUG, baseURL: "http://127.0.0.1:9/api/v1/", fetchImpl: (async (u: string) => (seen.push(u), ok())) as unknown as typeof fetch });
    await call(llm);
    expect(seen[0]).toBe("http://127.0.0.1:9/api/v1/chat/completions");
  });
});

describe("responses and errors", () => {
  it("maps text, the echoed model and token usage", async () => {
    const c = await call(client(() => ok()).llm);
    expect(c.text).toBe(goodText);
    expect(c.model).toBe(SLUG);
    expect(c.usage).toEqual({ inputTokens: 1500, outputTokens: 400 });
  });

  it("401 / 402 / 400 / 404 are NOT retryable; 408 / 429 / 500 / 503 and a dead network ARE", async () => {
    for (const [s, retry] of [[401, false], [402, false], [400, false], [404, false], [408, true], [429, true], [500, true], [503, true]] as const) {
      const e = await rejection(call(client(() => err(s, "x")).llm));
      expect(e, String(s)).toBeInstanceOf(LlmError);
      expect((e as LlmError).retryable, String(s)).toBe(retry);
      expect((e as LlmError).message).toContain(String(s));
    }
    const dead = await rejection(call(client(() => { throw new TypeError("fetch failed"); }).llm));
    expect((dead as LlmError).retryable).toBe(true);
  });

  it("OpenRouter can answer HTTP 200 with an error body: that is an error too", async () => {
    const e = (await rejection(call(client(() => new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), { status: 200 })).llm))) as LlmError;
    expect(e.message).toMatch(/402.*Insufficient credits/);
    expect(e.retryable).toBe(false);
  });

  it("finish_reason 'length' is a retryable error; a refusal or content filter is not; empty content comes back empty (the validator rejects it)", async () => {
    const len = (await rejection(call(client(() => ok({ choices: [{ finish_reason: "length", message: { content: "{" } }] })).llm))) as LlmError;
    expect(len.message).toMatch(/max_tokens/);
    expect(len.retryable).toBe(true);
    const ref = (await rejection(call(client(() => ok({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can't" } }] })).llm))) as LlmError;
    expect(ref.retryable).toBe(false);
    const cf = (await rejection(call(client(() => ok({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] })).llm))) as LlmError;
    expect(cf.retryable).toBe(false);
    expect((await call(client(() => ok({ choices: [{ finish_reason: "stop", message: { content: null } }] })).llm)).text).toBe("");
  });
});

describe("through the handler", () => {
  it("good answer: source llm, the OpenRouter slug is the reported model, one call", async () => {
    const { llm, seen } = client(() => ok());
    const { call: post } = await setup(llm);
    const r = await (await post(p)).json();
    expect(r.source).toBe("llm");
    expect(r.model).toBe(SLUG);
    expect(seen.length).toBe(1);
  });

  it("402 (no credits) makes ONE call, not three, then serves Tier 1 text with the reason; 429 is retried up to the limit", async () => {
    const a = client(() => err(402, "Insufficient credits"));
    const ra = await (await (await setup(a.llm)).call(p)).json();
    expect(a.seen.length).toBe(1);
    expect(ra.source).toBe("tier1-fallback");
    expect(ra.items).toEqual(tier1FallbackItems(p));
    expect(ra.rejections[0]).toMatch(/402/);
    const b = client(() => err(429, "rate limited"));
    const rb = await (await (await setup(b.llm)).call(p)).json();
    expect(b.seen.length).toBe(3);
    expect(rb.source).toBe("tier1-fallback");
  });

  it("validator still gates OpenRouter output: a hallucinated number is rejected and retried", async () => {
    const bad = JSON.stringify({ items: tier1FallbackItems(p).map((i, n) => (n === 0 ? { ...i, explanation: `${i.explanation} That is 777 dB.` } : i)) });
    const { llm, seen } = client((_u, _i, n) => (n === 1 ? ok({ choices: [{ finish_reason: "stop", message: { content: bad } }] }) : ok()));
    const r = await (await (await setup(llm)).call(p)).json();
    expect(r.source).toBe("llm");
    expect(r.attempts).toBe(2);
    expect(seen[1]!.body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("the cache key includes the model: the same payload under a different model is a miss", async () => {
    const cache = new TtlLru<PhrasingResult>(10, 60_000);
    const a = client(() => ok());
    await (await setup(a.llm, { cache })).call(p);
    const b = client(() => ok());
    const other = createOpenRouterLlm({ apiKey: "k", model: "anthropic/claude-sonnet-5-5", fetchImpl: (async () => ok()) as unknown as typeof fetch });
    const r2 = await (await (await setup(other, { cache })).call(p)).json();
    expect(r2.source).toBe("llm"); // not "cache"
    expect(b.seen.length).toBe(0);
    const r3 = await (await (await setup(a.llm, { cache })).call(p)).json();
    expect(r3.source).toBe("cache");
  });
});

describe("provider selection from env", () => {
  const sel = (env: Record<string, string>) => chooseLlm(env);
  it("picks whichever key exists; Anthropic wins when both are set unless LLM_PROVIDER says otherwise", () => {
    expect(sel({ ANTHROPIC_API_KEY: "a" })).toMatchObject({ provider: "anthropic", expectedModel: "claude-haiku-5-5" });
    expect(sel({ OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: SLUG })).toMatchObject({ provider: "openrouter", expectedModel: SLUG });
    expect(sel({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: SLUG })).toMatchObject({ provider: "anthropic" });
    expect(sel({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: SLUG, LLM_PROVIDER: "openrouter" })).toMatchObject({ provider: "openrouter" });
    expect(sel({ OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: SLUG }).llm?.modelId).toBe(SLUG);
  });
  it("misconfiguration never throws: llm is null and the reason says what to set (no guessed model slug)", () => {
    expect(sel({})).toMatchObject({ llm: null, provider: null, reason: expect.stringMatching(/no ANTHROPIC_API_KEY or OPENROUTER_API_KEY/) });
    expect(sel({ OPENROUTER_API_KEY: "o" })).toMatchObject({ llm: null, provider: "openrouter", reason: expect.stringMatching(/OPENROUTER_MODEL is not set/) });
    expect(sel({ LLM_PROVIDER: "openrouter", ANTHROPIC_API_KEY: "a" })).toMatchObject({ llm: null, reason: expect.stringMatching(/OPENROUTER_API_KEY is not set/) });
    expect(sel({ LLM_PROVIDER: "anthropic", OPENROUTER_API_KEY: "o" })).toMatchObject({ llm: null, reason: expect.stringMatching(/ANTHROPIC_API_KEY is not set/) });
    expect(sel({ LLM_PROVIDER: "bedrock", ANTHROPIC_API_KEY: "a" })).toMatchObject({ llm: null, reason: expect.stringMatching(/must be "anthropic" or "openrouter"/) });
  });
});
