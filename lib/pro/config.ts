/**
 * Pro-tier phrasing layer: every number lives here (mirrors the "config is the only source of numbers" rule).
 * This module is PRO ONLY. Free-path code must never import it (enforced by scripts/check-pro-boundary.mjs and a unit test).
 */
export const PRO_CONFIG = {
  /**
   * Haiku-class: this is rewording of text that is already decided, not reasoning.
   * Id checked against the published model catalogue on 2026-10-22 (platform.claude.com/docs/en/models/overview): Claude Haiku 5.5, API id
   * and alias "claude-haiku-5-5", 1M context, 128K max output, retirement not sooner than 2027-10-07. NOT yet executed against the live API
   * (no key in the build environment): run `npm run smoke:pro` with ANTHROPIC_API_KEY set.
   */
  model: "claude-haiku-5-5",
  /** Change this whenever the system prompt, schema or validation rules change: it is part of every cache key. */
  promptVersion: "2",
  /** `output_config.effort`. Low: rewording needs no deep reasoning (and thinking tokens are billed as output). */
  effort: "low" as const,
  /** Hard cost cap on one attempt's output. 12 items x (80+420+300 chars) fits comfortably. */
  maxOutputTokens: 4096,
  /** Retries after the first attempt when the output is rejected. Total attempts = 1 + maxRetries. */
  maxRetries: 2,
  attemptTimeoutMs: 8000,
  totalDeadlineMs: 22000,
  limits: {
    maxFindings: 12,
    maxRequestBytes: 24_000,
    headlineMaxChars: 80,
    explanationMaxChars: 420,
    suggestedMoveMaxChars: 300,
    maxTextChars: 400,
  },
  cache: {
    /** Server-side, in-memory, per server instance (best-effort). The client keeps a durable IndexedDB cache. */
    serverMaxEntries: 500,
    serverTtlMs: 24 * 60 * 60 * 1000,
    clientMaxEntries: 200,
  },
  rateLimit: {
    windowMs: 60 * 60 * 1000,
    perInstall: 20,
    perIp: 60,
    /** Cost backstop when a key leaks: nonces and IPs are cheap to vary, a key is not. Counted per key label. */
    perKey: 600,
    /** Shared store (Upstash REST) per-request timeout; on error the in-memory limiter decides that request. */
    storeTimeoutMs: 1500,
    nonceMinChars: 32,
    nonceMaxChars: 64,
  },
  client: {
    requestTimeoutMs: 26000,
  },
  /**
   * Cost model. Prices: Claude Haiku 5.5, base input / output, prompts up to 100,000 tokens (above that the rates are 5x higher; this app
   * never gets near it). Source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-22.
   * charsPerToken: the models-overview page says 1M tokens is about 2.5M characters on the current tokenizer. Token COUNTS from it are
   * estimates until a real call (npm run smoke:pro) reports them.
   */
  pricing: { pricePerMTokIn: 0.1, pricePerMTokOut: 0.5, source: "https://platform.claude.com/docs/en/about-claude/pricing", checked: "2026-10-22" },
  costEstimate: { charsPerToken: 2.5 },
} as const;
