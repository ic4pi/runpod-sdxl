import { verifyProToken, type ProKey } from "./auth";
import { canonicalViolations } from "./canonical";
import { PRO_CONFIG } from "./config";
import { tier1FallbackItems } from "./findings";
import { canonicalJson, sha256Hex } from "./hash";
import type { LlmClient, LlmTurn } from "./llm";
import type { RateLimit, TtlLru } from "./limits";
import { buildRetryMessage, buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { PhrasingRequestSchema, type PhrasingPayload, type PhrasingResult } from "./schema";
import { validatePhrasing, type Violation } from "./validate";

export interface HandlerDeps {
  /** null when ANTHROPIC_API_KEY is not configured. */
  llm: LlmClient | null;
  proKeys: readonly ProKey[];
  cache: TtlLru<PhrasingResult>;
  limiter: RateLimit;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const NONCE = new RegExp(`^[A-Za-z0-9_-]{${PRO_CONFIG.rateLimit.nonceMinChars},${PRO_CONFIG.rateLimit.nonceMaxChars}}$`);
/** On Vercel the platform sets these from the real connection (a client cannot spoof them). Behind any other proxy that does not strip them, the per-IP limit is only as good as that proxy. */
const clientIp = (req: Request) => req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
/** Raw nonces and IPs are never sent to the store: only a truncated hash. */
const bucket = async (kind: string, v: string) => `${kind}:${(await sha256Hex(v)).slice(0, 32)}`;
const shortReason = (vs: readonly Violation[]) => vs.map((v) => `${v.kind}: ${v.detail}`).join("; ").slice(0, 280);

/**
 * POST /api/phrasing. Never fails closed for a valid request: if the model is unavailable, unconfigured, slow, or keeps
 * producing output the validator rejects, the response is 200 with Tier 1's own text (`source: "tier1-fallback"`).
 */
export async function handlePhrasing(req: Request, deps: HandlerDeps): Promise<Response> {
  const t0 = deps.now();
  if (req.method !== "POST") return json({ error: "method-not-allowed" }, 405, { allow: "POST" });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > PRO_CONFIG.limits.maxRequestBytes) return json({ error: "too-large" }, 413);
  const bodyText = await req.text();
  if (bodyText.length > PRO_CONFIG.limits.maxRequestBytes) return json({ error: "too-large" }, 413);

  const auth = await verifyProToken(req.headers.get("authorization"), deps.proKeys);
  if (auth.status === "not-configured") return json({ error: "pro-not-configured" }, 503);
  if (auth.status !== "ok") return json({ error: auth.status === "missing" ? "pro-key-required" : "pro-key-invalid" }, 401);
  const keyLabel = auth.key.label;

  const nonce = req.headers.get("x-install-nonce") ?? "";
  if (!NONCE.test(nonce)) return json({ error: "bad-install-nonce" }, 400);

  let payload: PhrasingPayload;
  try {
    const parsed = PhrasingRequestSchema.safeParse(JSON.parse(bodyText));
    if (!parsed.success) return json({ error: "invalid-request", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    payload = parsed.data.payload;
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const forged = canonicalViolations(payload);
  if (forged.length) return json({ error: "non-canonical-payload", issues: forged.slice(0, 5) }, 400);

  const base = { prompt_version: PRO_CONFIG.promptVersion, model: PRO_CONFIG.model };
  const fallback = (reason: string, attempts: number, rejections: string[] = []): Response => {
    const body: PhrasingResult = { source: "tier1-fallback", items: tier1FallbackItems(payload), attempts, fallback_reason: reason.slice(0, 200), ...(rejections.length ? { rejections } : {}), ...base };
    deps.log({ event: "phrasing", source: "tier1-fallback", reason, attempts, ms: deps.now() - t0 });
    return json(body);
  };

  try {
    const key = await sha256Hex(canonicalJson({ v: PRO_CONFIG.promptVersion, model: PRO_CONFIG.model, payload }));
    const hit = deps.cache.get(key, deps.now());
    if (hit) {
      deps.log({ event: "phrasing", source: "cache", hash: key.slice(0, 12), ms: deps.now() - t0 });
      return json({ ...hit, source: "cache", attempts: 0, rejections: undefined, fallback_reason: undefined });
    }

    // Cache misses are the only requests that can cost money. They are rate limited BEFORE any model call: per install, per IP, per key.
    // A request that is limited returns here and never reaches the model. Cache hits above are free.
    const rl = PRO_CONFIG.rateLimit;
    for (const [k, limit] of [[await bucket("nonce", nonce), rl.perInstall], [await bucket("ip", clientIp(req)), rl.perIp], [await bucket("key", auth.key.hash), rl.perKey]] as const) {
      const r = await deps.limiter.take(k, limit, deps.now());
      if (!r.ok) {
        deps.log({ event: "phrasing-rate-limited", scope: k.split(":")[0], key: keyLabel, retryAfterSec: r.retryAfterSec });
        return json({ error: "rate-limited" }, 429, { "retry-after": String(r.retryAfterSec) });
      }
    }

    if (!deps.llm) return fallback("llm-unconfigured", 0);

    const turns: LlmTurn[] = [{ role: "user", content: buildUserMessage(payload) }];
    const rejections: string[] = [];
    const maxAttempts = 1 + PRO_CONFIG.maxRetries;
    let usageIn = 0;
    let usageOut = 0;
    let attempts = 0;
    while (attempts < maxAttempts) {
      const remaining = PRO_CONFIG.totalDeadlineMs - (deps.now() - t0);
      if (remaining <= 500) {
        rejections.push("deadline reached");
        break;
      }
      attempts++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(PRO_CONFIG.attemptTimeoutMs, remaining));
      let text = "";
      try {
        const c = await deps.llm.complete({ system: SYSTEM_PROMPT, messages: turns, signal: ctl.signal });
        text = c.text;
        usageIn += c.usage?.inputTokens ?? 0;
        usageOut += c.usage?.outputTokens ?? 0;
      } catch (e) {
        rejections.push(`llm error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
        continue;
      } finally {
        clearTimeout(timer);
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        const v: Violation[] = [{ kind: "shape", detail: "output was not valid JSON" }];
        rejections.push(shortReason(v));
        turns.push({ role: "assistant", content: text.slice(0, 4000) }, { role: "user", content: buildRetryMessage(v) });
        continue;
      }
      const verdict = validatePhrasing(payload, raw);
      if (verdict.ok) {
        const result: PhrasingResult = { source: "llm", items: verdict.items, attempts, ...(rejections.length ? { rejections } : {}), ...base };
        deps.cache.set(key, result, deps.now()); // only validated model output is ever cached
        deps.log({ event: "phrasing", source: "llm", key: keyLabel, attempts, hash: key.slice(0, 12), in: usageIn, out: usageOut, ms: deps.now() - t0 });
        return json(result);
      }
      rejections.push(shortReason(verdict.violations));
      turns.push({ role: "assistant", content: text.slice(0, 4000) }, { role: "user", content: buildRetryMessage(verdict.violations) });
    }
    deps.log({ event: "phrasing-rejected", attempts, in: usageIn, out: usageOut });
    return fallback(`model output not usable after ${attempts} attempt${attempts === 1 ? "" : "s"}`, attempts, rejections);
  } catch (e) {
    return fallback(`internal error: ${e instanceof Error ? e.message : String(e)}`, 0);
  }
}
