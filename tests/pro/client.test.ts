/** Browser client: cache, no-key (zero fetch), POST shape, local re-validation. fake-indexeddb; fetch is a scripted fake; metrics SYNTHETIC. */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { PRO_CONFIG } from "../../lib/pro/config";
import { getInstallNonce, phrasingCacheKey, requestPhrasing, setProKey } from "../../lib/pro/client";
import { tier1FallbackItems } from "../../lib/pro/findings";
import type { PhrasingResult } from "../../lib/pro/schema";
import { openStorage } from "../../lib/storage/idb";
import { ABSENT, THREE_FINDINGS } from "./helpers";

const mk = () => openStorage({ factory: new IDBFactory(), name: `t${Math.random()}`, maxSessions: 5 });
const p = THREE_FINDINGS();
const good = () => tier1FallbackItems(p).map((i) => ({ ...i, explanation: `In plain words: ${i.explanation}` }));
const reply = (over: Partial<PhrasingResult> = {}, status = 200) =>
  new Response(JSON.stringify({ source: "llm", items: good(), attempts: 1, prompt_version: PRO_CONFIG.promptVersion, model: "m", ...over }), { status });

describe("client", () => {
  it("NO PRO KEY => zero fetch calls, Tier 1 text", async () => {
    const storage = await mk();
    const f = vi.fn();
    const r = await requestPhrasing({ payload: p, storage, fetchImpl: f as unknown as typeof fetch });
    expect(f).not.toHaveBeenCalled();
    expect(r.source).toBe("tier1-fallback");
    expect(r.items).toEqual(tier1FallbackItems(p));
    expect(r.fallbackReason).toMatch(/No Pro key/);
  });

  it("with a key: one POST with Bearer key + install nonce + exactly {payload}; result cached locally; repeat makes ZERO fetches", async () => {
    const storage = await mk();
    await setProKey(storage, "my-pro-key-123456");
    const f = vi.fn(async () => reply());
    const a = await requestPhrasing({ payload: p, storage, fetchImpl: f as unknown as typeof fetch });
    expect(a.source).toBe("llm");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/phrasing");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer my-pro-key-123456");
    expect((init.headers as Record<string, string>)["x-install-nonce"]).toBe(await getInstallNonce(storage));
    expect(Object.keys(JSON.parse(init.body as string))).toEqual(["payload"]);
    const b = await requestPhrasing({ payload: p, storage, fetchImpl: f as unknown as typeof fetch });
    expect(b.source).toBe("cache");
    expect(b.cache).toBe("local");
    expect(f).toHaveBeenCalledTimes(1);
    expect(b.items).toEqual(a.items);
  });

  it("install nonce is stable across calls and long enough for the server", async () => {
    const storage = await mk();
    const n1 = await getInstallNonce(storage);
    expect(n1.length).toBeGreaterThanOrEqual(PRO_CONFIG.rateLimit.nonceMinChars);
    expect(await getInstallNonce(storage)).toBe(n1);
  });

  it("DEFENCE IN DEPTH: a server answer carrying a hallucinated number is rejected locally and not cached", async () => {
    const storage = await mk();
    await setProKey(storage, "my-pro-key-123456");
    const items = good();
    items[0] = { ...items[0]!, suggested_move: `Cut ${ABSENT} dB.` };
    const f = vi.fn(async () => reply({ items }));
    const r = await requestPhrasing({ payload: p, storage, fetchImpl: f as unknown as typeof fetch });
    expect(r.source).toBe("tier1-fallback");
    expect(JSON.stringify(r.items)).not.toContain(String(ABSENT));
    expect(r.fallbackReason).toMatch(/local number check/);
    expect(await storage.getCached(await phrasingCacheKey(p))).toBeUndefined();
  });

  it("a poisoned local cache entry is ignored (re-validated on read)", async () => {
    const storage = await mk();
    await setProKey(storage, "my-pro-key-123456");
    const bad = good();
    bad[0] = { ...bad[0]!, explanation: `Boost by ${ABSENT} dB` };
    await storage.putCached(await phrasingCacheKey(p), bad, 10);
    const f = vi.fn(async () => reply());
    const r = await requestPhrasing({ payload: p, storage, fetchImpl: f as unknown as typeof fetch });
    expect(r.source).toBe("llm");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("every failure falls back to Tier 1 text and never throws: 401, 429, 500, network error, garbage body, server fallback", async () => {
    const storage = await mk();
    await setProKey(storage, "my-pro-key-123456");
    const cases: Array<() => Promise<Response>> = [
      async () => new Response("{}", { status: 401 }),
      async () => new Response("{}", { status: 429 }),
      async () => new Response("boom", { status: 500 }),
      async () => { throw new TypeError("Failed to fetch"); },
      async () => new Response("<html>", { status: 200 }),
      async () => reply({ source: "tier1-fallback", items: tier1FallbackItems(p), fallback_reason: "model output not usable after 3 attempts" }),
    ];
    for (const c of cases) {
      const r = await requestPhrasing({ payload: p, storage, fetchImpl: c as unknown as typeof fetch });
      expect(r.source).toBe("tier1-fallback");
      expect(r.items).toEqual(tier1FallbackItems(p));
      expect(r.fallbackReason).toBeTruthy();
    }
  });

  it("cache key depends on the prompt version and the payload", async () => {
    const k1 = await phrasingCacheKey(p);
    const k2 = await phrasingCacheKey({ ...p, reference_genre_label: "Other" });
    expect(k1).not.toBe(k2);
    expect(k1).toMatch(/^phrasing:[0-9a-f]{64}$/);
  });
});
