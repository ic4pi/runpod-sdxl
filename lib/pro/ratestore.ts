import { PRO_CONFIG } from "./config";
import type { RateLimit, RateResult } from "./limits";
import { RateLimiter } from "./limits";

/**
 * Shared rate-limit store. Production: Upstash Redis over its REST API (works on any runtime, no TCP). Fallback: the in-memory limiter,
 * which is per server instance. The protocol below (POST {url}/multi-exec, Authorization: Bearer, body = array of command arrays,
 * response = array of {result}|{error}) is taken from the official @upstash/redis client source (v1.39.0), not from memory.
 *
 * Fixed window: key = prefix + caller key + window index, INCR + PEXPIRE in one MULTI/EXEC. A caller can burst up to 2x the limit across a
 * window boundary; that is accepted for a cost guard.
 */
export interface RateStore {
  incr(key: string, windowMs: number, now: number): Promise<{ count: number; resetInMs: number }>;
}

export class UpstashRateStore implements RateStore {
  private readonly url: string;
  constructor(
    url: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs: number = PRO_CONFIG.rateLimit.storeTimeoutMs,
  ) {
    this.url = url.replace(/\/+$/, "");
  }
  async incr(key: string, windowMs: number, now: number): Promise<{ count: number; resetInMs: number }> {
    const win = Math.floor(now / windowMs);
    const k = `vr:rl:${key}:${win}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}/multi-exec`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify([["INCR", k], ["PEXPIRE", k, String(windowMs * 2)]]),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`rate store HTTP ${res.status}`);
      const out = (await res.json()) as Array<{ result?: unknown; error?: string }>;
      if (!Array.isArray(out) || out.length !== 2 || out[0]?.error || typeof out[0]?.result !== "number") throw new Error(`rate store bad reply: ${JSON.stringify(out).slice(0, 120)}`);
      return { count: out[0].result, resetInMs: (win + 1) * windowMs - now };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Uses the shared store; if the store errors or times out, THAT request is limited by the in-memory fallback instead (never unlimited, never a 5xx). */
export class StoreRateLimiter implements RateLimit {
  constructor(
    private store: RateStore,
    private windowMs: number,
    private fallback: RateLimit,
    private onError: (e: unknown) => void = () => {},
  ) {}
  async take(key: string, limit: number, now: number): Promise<RateResult> {
    try {
      const { count, resetInMs } = await this.store.incr(key, this.windowMs, now);
      return count <= limit ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil(resetInMs / 1000)) };
    } catch (e) {
      this.onError(e);
      return this.fallback.take(key, limit, now);
    }
  }
}

export type RateLimiterKind = "upstash" | "memory";

/** Picks the store from env. UPSTASH_REDIS_REST_URL/TOKEN (or the Vercel KV names KV_REST_API_URL/TOKEN, same protocol). */
export function createRateLimiter(
  env: Record<string, string | undefined>,
  opts: { fetchImpl?: typeof fetch; onError?: (e: unknown) => void } = {},
): { limiter: RateLimit; kind: RateLimiterKind } {
  const memory = new RateLimiter(PRO_CONFIG.rateLimit.windowMs);
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token || !/^https?:\/\//.test(url)) return { limiter: memory, kind: "memory" };
  return { limiter: new StoreRateLimiter(new UpstashRateStore(url, token, opts.fetchImpl), PRO_CONFIG.rateLimit.windowMs, memory, opts.onError), kind: "upstash" };
}
