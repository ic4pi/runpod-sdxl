import { parseProKeys } from "@/lib/pro/auth";
import { PRO_CONFIG } from "@/lib/pro/config";
import { handlePhrasing, type HandlerDeps } from "@/lib/pro/handler";
import { TtlLru } from "@/lib/pro/limits";
import { chooseLlm } from "@/lib/pro/provider";
import { createRateLimiter } from "@/lib/pro/ratestore";
import type { PhrasingResult } from "@/lib/pro/schema";

/**
 * Pro-only. The Free tier never calls this route (see scripts/check-pro-boundary.mjs).
 * Runtime: Node.js, which is the Next 16 default. There is deliberately NO `runtime` export: the edge runtime is deprecated, and Next's
 * docs for 16.4 say to remove the export (node_modules/next/dist/docs/.../route-segment-config/runtime.md).
 * maxDuration covers PRO_CONFIG.totalDeadlineMs (22 s) plus overhead.
 */
export const maxDuration = 30;

// Module scope = one per server instance. The response cache is per instance (best-effort); the rate limit is shared when Upstash is configured.
const cache = new TtlLru<PhrasingResult>(PRO_CONFIG.cache.serverMaxEntries, PRO_CONFIG.cache.serverTtlMs);
let rate: ReturnType<typeof createRateLimiter> | null = null;
const getRate = () =>
  (rate ??= (() => {
    const r = createRateLimiter(process.env, { onError: (e) => console.error(JSON.stringify({ event: "rate-store-error", error: e instanceof Error ? e.message : String(e) })) });
    console.log(JSON.stringify({ event: "phrasing-config", rateLimitStore: r.kind }));
    return r;
  })());

let llmChoice: ReturnType<typeof chooseLlm> | null = null;
const getLlm = () =>
  (llmChoice ??= (() => {
    const c = chooseLlm(process.env);
    console.log(JSON.stringify({ event: "phrasing-config", provider: c.provider, model: c.llm?.modelId ?? null, ...(c.llm ? {} : { llmUnavailable: c.reason }) }));
    return c;
  })());

function deps(): HandlerDeps {
  const { keys, errors } = parseProKeys(process.env.PRO_TOKEN_HASHES);
  if (errors.length) console.error(JSON.stringify({ event: "pro-keys-config-error", errors }));
  return {
    llm: getLlm().llm,
    proKeys: keys,
    cache,
    limiter: getRate().limiter,
    now: () => Date.now(),
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}

export async function POST(req: Request): Promise<Response> {
  return handlePhrasing(req, deps());
}

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ error: "method-not-allowed" }), { status: 405, headers: { allow: "POST", "content-type": "application/json" } });
}
