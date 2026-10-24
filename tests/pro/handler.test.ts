/** /api/phrasing handler: retries, rejection, cache, fallback, auth, rate limit. The LLM is a SCRIPTED FAKE (no network); metrics are SYNTHETIC. */
import { describe, expect, it } from "vitest";
import { tier1FallbackItems } from "../../lib/pro/findings";
import { handlePhrasing } from "../../lib/pro/handler";
import type { LlmClient } from "../../lib/pro/llm";
import { RateLimiter, TtlLru } from "../../lib/pro/limits";
import { PRO_CONFIG } from "../../lib/pro/config";
import type { PhrasingPayload, PhrasingResult } from "../../lib/pro/schema";
import { profileValueAtPct } from "../../lib/decision/evaluate";
import { sha256Hex } from "../../lib/pro/hash";
import { FakeLlm, hallucinated, KEY, NONCE, okText, setup } from "./handlerHarness";
import { ABSENT, metricsTripping, payloadFrom, THREE_FINDINGS, trap } from "./helpers";

const bodyOf = async (r: Response) => (await r.json()) as PhrasingResult & { error?: string };

describe("happy path and the numeric rejection loop", () => {
  it("valid model output -> source 'llm', 1 call, items are the model's, cached afterwards", async () => {
    const p = THREE_FINDINGS();
    const llm = new FakeLlm([okText(p)]);
    const { call } = await setup(llm);
    const r = await bodyOf(await call(p));
    expect(r.source).toBe("llm");
    expect(r.attempts).toBe(1);
    expect(r.items[0]!.explanation).toMatch(/^In plain words:/);
    expect(llm.calls.length).toBe(1);
  });

  it("A HALLUCINATED NUMBER IS REJECTED AND RETRIED: bad first answer, good second -> 2 calls, retry message names the violation", async () => {
    const p = THREE_FINDINGS();
    const llm = new FakeLlm([hallucinated(p), okText(p)]);
    const { call } = await setup(llm);
    const r = await bodyOf(await call(p));
    expect(r.source).toBe("llm");
    expect(r.attempts).toBe(2);
    expect(r.rejections?.[0]).toContain(String(ABSENT));
    expect(JSON.stringify(r.items)).not.toContain(String(ABSENT)); // the hallucination never reaches the user
    const retryTurn = llm.calls[1]!;
    expect(retryTurn.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(retryTurn[2]!.content).toContain(String(ABSENT));
    expect(retryTurn[2]!.content).toMatch(/rejected by an automatic check/);
  });

  it("ALWAYS hallucinating -> exactly 1 + 2 retries = 3 calls, then Tier 1 raw text (source 'tier1-fallback'), still HTTP 200", async () => {
    const p = THREE_FINDINGS();
    const llm = new FakeLlm([hallucinated(p)]);
    const { call } = await setup(llm);
    const res = await call(p);
    expect(res.status).toBe(200);
    const r = await bodyOf(res);
    expect(llm.calls.length).toBe(1 + PRO_CONFIG.maxRetries);
    expect(llm.calls.length).toBe(3);
    expect(r.source).toBe("tier1-fallback");
    expect(r.attempts).toBe(3);
    expect(r.items).toEqual(tier1FallbackItems(p));
    expect(r.fallback_reason).toMatch(/not usable after 3 attempts/);
    expect(r.rejections?.length).toBe(3);
    expect(JSON.stringify(r)).not.toContain(`Cut ${ABSENT}`);
  });

  it("other rejection causes also retry then fall back: invalid JSON, schema-invalid, foreign id, topic creep, number words", async () => {
    const p = THREE_FINDINGS();
    const wrongId = okText(p, (items) => [...items, { coaching_id: "lufs_over", headline: "Loud", explanation: "x".repeat(15), suggested_move: "y".repeat(15) }]);
    const topic = okText(p, (items) => items.map((i, n) => (n === 0 ? { ...i, explanation: "Your hiss and room noise also matter." } : i)));
    const words = okText(p, (items) => items.map((i, n) => (n === 0 ? { ...i, explanation: "Turn it down by three decibels." } : i)));
    for (const bad of ["not json at all", JSON.stringify({ items: [{ coaching_id: "nope" }] }), wrongId, topic, words]) {
      const llm = new FakeLlm([bad]);
      const { call } = await setup(llm);
      const r = await bodyOf(await call(p));
      expect(r.source, bad.slice(0, 40)).toBe("tier1-fallback");
      expect(llm.calls.length).toBe(3);
    }
  });

  it("the model erroring or timing out falls back too (never throws, never 5xx)", async () => {
    const p = THREE_FINDINGS();
    const llm = new FakeLlm([new Error("upstream 529 overloaded")]);
    const { call } = await setup(llm);
    const res = await call(p);
    expect(res.status).toBe(200);
    const r = await bodyOf(res);
    expect(r.source).toBe("tier1-fallback");
    expect(r.rejections?.[0]).toMatch(/overloaded/);
  });

  it("a hung model is cut off by the per-attempt timeout", async () => {
    const p = THREE_FINDINGS();
    const hang: LlmClient = { modelId: PRO_CONFIG.model, complete: ({ signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) };
    const { call } = await setup(hang, { now: () => Date.now() });
    const orig = PRO_CONFIG.attemptTimeoutMs;
    const started = Date.now();
    const res = await Promise.race([call(p), new Promise<Response>((r) => setTimeout(() => r(new Response("timeout-in-test", { status: 599 })), 60_000))]);
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).source).toBe("tier1-fallback");
    expect(Date.now() - started).toBeLessThan(PRO_CONFIG.totalDeadlineMs + 2000);
    void orig;
  }, 40_000);

  it("no ANTHROPIC_API_KEY (llm = null) -> fallback without any call", async () => {
    const p = THREE_FINDINGS();
    const { call } = await setup(null);
    const r = await bodyOf(await call(p));
    expect(r.source).toBe("tier1-fallback");
    expect(r.fallback_reason).toBe("llm-unconfigured");
    expect(r.attempts).toBe(0);
  });
});

describe("cache", () => {
  it("IDENTICAL INPUT => zero-cost repeat: second request makes NO model call and is source 'cache'", async () => {
    const p = THREE_FINDINGS();
    const llm = new FakeLlm([okText(p)]);
    const { call, logs } = await setup(llm);
    const first = await bodyOf(await call(p));
    const second = await bodyOf(await call(JSON.parse(JSON.stringify(p))));
    const third = await bodyOf(await call(p));
    expect(first.source).toBe("llm");
    expect(second.source).toBe("cache");
    expect(third.source).toBe("cache");
    expect(llm.calls.length).toBe(1); // the only model call
    expect(second.items).toEqual(first.items);
    expect(second.attempts).toBe(0);
    expect(logs.filter((l) => l.source === "cache").length).toBe(2);
  });

  it("different input => miss; fallback results are never cached; expired entries are re-fetched", async () => {
    const a = THREE_FINDINGS();
    const b = payloadFrom(metricsTripping({ boxiness_250hz_rel_db: profileValueAtPct(trap, "boxiness_250hz_rel_db", 90) + 2.2 }));
    const llm = new FakeLlm([(t) => okText(JSON.parse(t[0]!.content.slice(t[0]!.content.indexOf("{"))) as PhrasingPayload)]);
    const { call, deps } = await setup(llm);
    await call(a);
    await call(b);
    expect(llm.calls.length).toBe(2);
    // fallback is not cached
    const bad = new FakeLlm([hallucinated(a)]);
    const s2 = await setup(bad);
    await s2.call(a);
    expect(s2.deps.cache.size).toBe(0);
    await s2.call(a);
    expect(bad.calls.length).toBe(6); // asked again: nothing was cached
    // TTL
    let now = 0;
    const cache = new TtlLru<PhrasingResult>(5, 100);
    cache.set("k", { source: "llm" } as PhrasingResult, now);
    expect(cache.get("k", now + 50)).toBeDefined();
    expect(cache.get("k", now + 101)).toBeUndefined();
    void deps;
  });

  it("LRU evicts the least recently used", () => {
    const c = new TtlLru<number>(2, 1000);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.get("a", 1);
    c.set("c", 3, 2);
    expect(c.get("b", 3)).toBeUndefined();
    expect(c.get("a", 3)).toBe(1);
  });
});

describe("access control, validation, limits", () => {
  const p = THREE_FINDINGS();
  it("Pro only: no key / wrong key -> 401; server without any Pro keys configured -> 503", async () => {
    const llm = new FakeLlm([okText(p)]);
    const { call } = await setup(llm);
    expect((await call(p, { authorization: "" })).status).toBe(401);
    expect((await call(p, { authorization: "Bearer wrong-key-123456" })).status).toBe(401);
    expect((await (await setup(llm, { proKeys: [] })).call(p)).status).toBe(503);
    expect(llm.calls.length).toBe(0); // never reaches the model
  });
  it("bad install nonce -> 400; bad JSON / schema / unknown fields -> 400; GET -> 405; oversized -> 413", async () => {
    const { call, deps } = await setup(new FakeLlm([okText(p)]));
    expect((await call(p, { "x-install-nonce": "short" })).status).toBe(400);
    expect((await call(p, {}, "{not json")).status).toBe(400);
    expect((await call(p, {}, JSON.stringify({ payload: { ...p, coaching_ids: ["lufs_over"] } }))).status).toBe(400);
    expect((await call(p, {}, JSON.stringify({ payload: p, tier: "pro" }))).status).toBe(400);
    expect((await call(p, {}, "x".repeat(PRO_CONFIG.limits.maxRequestBytes + 1))).status).toBe(413);
    expect((await handlePhrasing(new Request("http://x/api/phrasing"), deps)).status).toBe(405);
  });
  it("rate limit per install: the 21st costly request in the window gets 429 + Retry-After; cache hits are free", async () => {
    const llm = new FakeLlm([(t) => okText(JSON.parse(t[0]!.content.slice(t[0]!.content.indexOf("{"))) as PhrasingPayload)]);
    const { call } = await setup(llm);
    const make = (i: number) => payloadFrom(metricsTripping({ boxiness_250hz_rel_db: profileValueAtPct(trap, "boxiness_250hz_rel_db", 90) + 1 + i * 0.1 }));
    for (let i = 0; i < PRO_CONFIG.rateLimit.perInstall; i++) expect((await call(make(i), { "x-forwarded-for": `10.0.${i}.1` })).status).toBe(200);
    const over = await call(make(99), { "x-forwarded-for": "10.9.9.9" });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call(make(0), { "x-forwarded-for": "10.9.9.9" })).status).toBe(200); // cached: free, no limit consumed
    expect((await call(make(98), { "x-install-nonce": "b".repeat(40), "x-forwarded-for": "10.9.9.9" })).status).toBe(200); // another install is unaffected
  });
  it("rate limit per IP across installs", async () => {
    const llm = new FakeLlm([(t) => okText(JSON.parse(t[0]!.content.slice(t[0]!.content.indexOf("{"))) as PhrasingPayload)]);
    const { call } = await setup(llm);
    const make = (i: number) => payloadFrom(metricsTripping({ boxiness_250hz_rel_db: profileValueAtPct(trap, "boxiness_250hz_rel_db", 90) + 1 + i * 0.1 }));
    let last = 200;
    for (let i = 0; i <= PRO_CONFIG.rateLimit.perIp; i++) last = (await call(make(i), { "x-install-nonce": `${i}`.padStart(40, "n"), "x-forwarded-for": "203.0.113.7" })).status;
    expect(last).toBe(429);
  });
  it("an unexpected exception inside the pipeline still yields 200 + Tier 1 text (never fails closed)", async () => {
    const { call } = await setup(new FakeLlm([okText(p)]), { cache: { get: () => { throw new Error("cache exploded"); }, set: () => {}, size: 0 } as unknown as TtlLru<PhrasingResult> });
    const res = await call(p);
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).source).toBe("tier1-fallback");
  });
});
