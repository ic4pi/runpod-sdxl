/** Rate limiting: shared store (against a LOCAL STUB of Upstash's REST API, not Upstash), memory fallback, and "limited => zero model calls". */
import { afterEach, describe, expect, it } from "vitest";
import { PRO_CONFIG } from "../../lib/pro/config";
import { RateLimiter } from "../../lib/pro/limits";
import { createRateLimiter, StoreRateLimiter, UpstashRateStore } from "../../lib/pro/ratestore";
import { tier1FallbackItems } from "../../lib/pro/findings";
import { profileValueAtPct } from "../../lib/decision/evaluate";
import { FakeLlm, NONCE, setup } from "./handlerHarness";
import { metricsTripping, payloadFrom, THREE_FINDINGS, trap } from "./helpers";
import { startStubUpstash, type StubUpstash } from "./stubUpstash";

const W = PRO_CONFIG.rateLimit.windowMs;
let stub: StubUpstash | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});
const instance = (s: StubUpstash, onError: (e: unknown) => void = () => {}) => new StoreRateLimiter(new UpstashRateStore(s.url, s.token), W, new RateLimiter(W), onError);

describe("shared store", () => {
  it("is shared across server instances: two 'instances' together get ONE budget (in-memory limiters would give each its own)", async () => {
    stub = await startStubUpstash();
    const a = instance(stub);
    const b = instance(stub);
    const now = 5 * W + 1000;
    let ok = 0;
    for (let i = 0; i < 15; i++) {
      if ((await a.take("nonce:x", 20, now)).ok) ok++;
      if ((await b.take("nonce:x", 20, now)).ok) ok++;
    }
    expect(ok).toBe(20); // 30 attempts, 20 allowed in total
    const mem = [new RateLimiter(W), new RateLimiter(W)];
    let memOk = 0;
    for (let i = 0; i < 15; i++) for (const m of mem) if (m.take("nonce:x", 20, now).ok) memOk++;
    expect(memOk).toBe(30); // what Phase 5 did: the limit was per instance, so it was 2x here
  });

  it("is atomic under concurrency: 60 simultaneous requests against a limit of 20 admit exactly 20", async () => {
    stub = await startStubUpstash();
    const l = instance(stub);
    const results = await Promise.all(Array.from({ length: 60 }, () => l.take("ip:y", 20, 7 * W)));
    expect(results.filter((r) => r.ok).length).toBe(20);
  });

  it("retry-after = seconds to the end of the window; the budget resets in the next window", async () => {
    stub = await startStubUpstash();
    const l = instance(stub);
    const start = 9 * W + 10 * 60 * 1000; // 10 minutes into a window
    for (let i = 0; i < 3; i++) await l.take("k", 3, start);
    const over = await l.take("k", 3, start);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.retryAfterSec).toBe(50 * 60); // 50 minutes left
    expect((await l.take("k", 3, start + 50 * 60 * 1000 + 1)).ok).toBe(true); // next window
  });

  it("speaks the documented protocol: POST /multi-exec, Bearer token, INCR then PEXPIRE", async () => {
    stub = await startStubUpstash();
    const seen: { url: string; init: RequestInit }[] = [];
    const spy: typeof fetch = async (u, init) => (seen.push({ url: String(u), init: init! }), fetch(u, init));
    await new UpstashRateStore(stub.url + "/", stub.token, spy).incr("k", W, 3 * W);
    expect(seen[0]!.url).toBe(`${stub.url}/multi-exec`);
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${stub.token}`);
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual([["INCR", "vr:rl:k:3"], ["PEXPIRE", "vr:rl:k:3", String(W * 2)]]);
  });

  it("selected from env: Upstash names, Vercel KV names, otherwise memory", () => {
    expect(createRateLimiter({}).kind).toBe("memory");
    expect(createRateLimiter({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" }).kind).toBe("memory"); // token missing
    expect(createRateLimiter({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }).kind).toBe("upstash");
    expect(createRateLimiter({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" }).kind).toBe("upstash");
    expect(createRateLimiter({ UPSTASH_REDIS_REST_URL: "not a url", UPSTASH_REDIS_REST_TOKEN: "t" }).kind).toBe("memory");
  });
});

describe("store failure: the in-memory limiter decides that request (never unlimited, never a 5xx)", () => {
  it("HTTP 500, wrong token (401) and a hung store all fall back, report the error, and the fallback still enforces the limit", async () => {
    stub = await startStubUpstash();
    for (const mode of [500, "wrong-token", "hang"] as const) {
      const errors: unknown[] = [];
      stub.fail = mode === 500 ? 500 : mode === "hang" ? "hang" : null;
      const store = new UpstashRateStore(stub.url, mode === "wrong-token" ? "nope" : stub.token, fetch, 200);
      const l = new StoreRateLimiter(store, W, new RateLimiter(W), (e) => errors.push(e));
      const r = [await l.take("k", 2, 11 * W), await l.take("k", 2, 11 * W), await l.take("k", 2, 11 * W)];
      expect(r.map((x) => x.ok), String(mode)).toEqual([true, true, false]); // fallback limits it
      expect(errors.length, String(mode)).toBe(3);
    }
  });
});

describe("handler: a rate-limited request makes ZERO model calls", () => {
  const variant = (i: number) => payloadFrom(metricsTripping({ boxiness_250hz_rel_db: profileValueAtPct(trap, "boxiness_250hz_rel_db", 90) + 1 + i * 0.1 }));
  const reply = (p: ReturnType<typeof THREE_FINDINGS>) => JSON.stringify({ items: tier1FallbackItems(p) });
  const scripted = () => new FakeLlm([(t) => reply(JSON.parse(t[0]!.content.slice(t[0]!.content.indexOf("{"))))]);

  it("memory limiter: the request over the install limit gets 429 + Retry-After and the model is NOT called", async () => {
    const llm = scripted();
    const { call, deps } = await setup(llm);
    for (let i = 0; i < PRO_CONFIG.rateLimit.perInstall; i++) expect((await call(variant(i), { "x-forwarded-for": `10.1.${i}.1` })).status).toBe(200);
    const callsBefore = llm.calls.length;
    expect(callsBefore).toBe(PRO_CONFIG.rateLimit.perInstall);
    const res = await call(variant(99), { "x-forwarded-for": "10.1.99.1" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate-limited" });
    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(W / 1000);
    expect(llm.calls.length, "ZERO upstream calls for the limited request").toBe(callsBefore);
    expect(deps.cache.size, "and nothing was cached for it").toBe(PRO_CONFIG.rateLimit.perInstall);
  });

  it("shared store: same guarantee, and the 429 is decided by the store (two handler instances share the budget)", async () => {
    stub = await startStubUpstash();
    const llmA = scripted();
    const llmB = scripted();
    const A = await setup(llmA, { limiter: instance(stub) });
    const B = await setup(llmB, { limiter: instance(stub) }); // a second server instance, own cache, own memory
    let served = 0;
    for (let i = 0; i < PRO_CONFIG.rateLimit.perInstall; i++) {
      const who = i % 2 ? A : B;
      if ((await who.call(variant(i), { "x-forwarded-for": `10.2.${i}.1` })).status === 200) served++;
    }
    expect(served).toBe(PRO_CONFIG.rateLimit.perInstall);
    const before = llmA.calls.length + llmB.calls.length;
    const res = await A.call(variant(50), { "x-forwarded-for": "10.2.50.1" });
    expect(res.status).toBe(429);
    const res2 = await B.call(variant(51), { "x-forwarded-for": "10.2.51.1" });
    expect(res2.status).toBe(429); // the OTHER instance is limited too: that is the point of a shared store
    expect(llmA.calls.length + llmB.calls.length, "ZERO upstream calls for both limited requests").toBe(before);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("per-IP and per-key limits both apply before the model", async () => {
    const llm = scripted();
    const { call } = await setup(llm);
    let last = 200;
    for (let i = 0; i <= PRO_CONFIG.rateLimit.perIp; i++) last = (await call(variant(i), { "x-install-nonce": `${i}`.padStart(40, "n"), "x-real-ip": "203.0.113.9" })).status;
    expect(last).toBe(429);
    expect(llm.calls.length).toBe(PRO_CONFIG.rateLimit.perIp);

    const llm2 = scripted();
    const s2 = await setup(llm2, { limiter: new RateLimiter(W) });
    let status = 200;
    for (let i = 0; i <= PRO_CONFIG.rateLimit.perKey; i++) status = (await s2.call(variant(i), { "x-install-nonce": `${i}`.padStart(40, "k"), "x-real-ip": `198.51.${Math.floor(i / 250)}.${i % 250}` })).status;
    expect(status).toBe(429);
    expect(llm2.calls.length).toBe(PRO_CONFIG.rateLimit.perKey);
  }, 60_000);

  it("requests that fail auth or validation never touch the store (an unauthenticated flood cannot spend it) and cache hits are free", async () => {
    stub = await startStubUpstash();
    const llm = scripted();
    const { call } = await setup(llm, { limiter: instance(stub) });
    await call(THREE_FINDINGS(), { authorization: "Bearer wrong-key-1234567" });
    await call(THREE_FINDINGS(), { "x-install-nonce": "short" });
    await call(THREE_FINDINGS(), {}, "{not json");
    expect(stub.requests).toBe(0);
    await call(THREE_FINDINGS());
    const afterMiss = stub.requests;
    expect(afterMiss).toBe(3); // nonce, ip, key
    await call(THREE_FINDINGS()); // cache hit
    expect(stub.requests).toBe(afterMiss);
  });

  it("the store never receives a raw nonce, IP or key label (only truncated hashes)", async () => {
    stub = await startStubUpstash();
    const { call } = await setup(scripted(), { limiter: instance(stub) });
    await call(THREE_FINDINGS(), { "x-forwarded-for": "198.51.100.77" });
    expect(stub.keys.length).toBeGreaterThan(0);
    for (const k of stub.keys) {
      expect(k).not.toContain(NONCE);
      expect(k).not.toContain("198.51.100.77");
      expect(k).not.toContain("test-key");
      expect(k).toMatch(/^vr:rl:(nonce|ip|key):[0-9a-f]{32}:\d+$/);
    }
  });
});
