import { parseHashList } from "@/lib/pro/auth";
import { PRO_CONFIG } from "@/lib/pro/config";
import { handlePhrasing, type HandlerDeps } from "@/lib/pro/handler";
import { RateLimiter, TtlLru } from "@/lib/pro/limits";
import { createAnthropicLlm } from "@/lib/pro/llm";
import type { PhrasingResult } from "@/lib/pro/schema";

/** Pro-only. Vercel Edge function. The Free tier never calls this route (see scripts/check-pro-boundary.mjs). */
export const runtime = "edge";

// module scope = one per edge isolate (best-effort cache and rate limit)
const cache = new TtlLru<PhrasingResult>(PRO_CONFIG.cache.serverMaxEntries, PRO_CONFIG.cache.serverTtlMs);
const limiter = new RateLimiter(PRO_CONFIG.rateLimit.windowMs);

function deps(): HandlerDeps {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return {
    llm: apiKey ? createAnthropicLlm({ apiKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined }) : null,
    proTokenHashes: parseHashList(process.env.PRO_TOKEN_HASHES),
    cache,
    limiter,
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
