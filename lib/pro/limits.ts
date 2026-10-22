/** In-memory TTL+LRU cache and fixed-window rate limiter. Per edge isolate: best-effort (see DECISIONS.md for what a shared store would add). */
export class TtlLru<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(
    private max: number,
    private ttlMs: number,
  ) {}
  get(key: string, now: number): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= now) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // refresh recency
    this.map.set(key, e);
    return e.v;
  }
  set(key: string, v: V, now: number): void {
    this.map.delete(key);
    this.map.set(key, { v, exp: now + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size(): number {
    return this.map.size;
  }
}

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private windowMs: number) {}
  /** Consumes one unit. Returns `{ok:false, retryAfterSec}` when the key is over its limit. */
  take(key: string, limit: number, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { ok: true };
    }
    if (cur.count >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
    cur.count++;
    return { ok: true };
  }
}
