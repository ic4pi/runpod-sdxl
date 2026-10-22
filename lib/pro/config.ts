/**
 * Pro-tier phrasing layer: every number lives here (mirrors the "config is the only source of numbers" rule).
 * This module is PRO ONLY. Free-path code must never import it (enforced by scripts/check-pro-boundary.mjs and a unit test).
 */
export const PRO_CONFIG = {
  /** Haiku-class: this is rewording of text that is already decided, not reasoning. $0.10 in / $0.50 out per MTok (Claude API list price, checked 2026-10-06). */
  model: "claude-haiku-5-5",
  /** Change this whenever the system prompt, schema or validation rules change: it is part of every cache key. */
  promptVersion: "1",
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
    /** Server-side, in-memory, per edge isolate (best-effort). The client keeps a durable IndexedDB cache. */
    serverMaxEntries: 500,
    serverTtlMs: 24 * 60 * 60 * 1000,
    clientMaxEntries: 200,
  },
  rateLimit: {
    windowMs: 60 * 60 * 1000,
    perInstall: 20,
    perIp: 60,
    nonceMinChars: 32,
    nonceMaxChars: 64,
  },
  client: {
    requestTimeoutMs: 26000,
  },
  /** Average characters per token used ONLY for the cost estimate (no API key here to measure real counts). */
  costEstimate: { charsPerToken: 3.2, pricePerMTokIn: 0.1, pricePerMTokOut: 0.5 },
} as const;
