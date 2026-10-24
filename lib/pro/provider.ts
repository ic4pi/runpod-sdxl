import { PRO_CONFIG } from "./config";
import { createAnthropicLlm, type LlmClient } from "./llm";
import { createOpenRouterLlm } from "./openrouter";

export type Provider = "anthropic" | "openrouter";
export type ProviderChoice = { llm: LlmClient; provider: Provider; expectedModel: string } | { llm: null; provider: Provider | null; reason: string };

/**
 * Which model backend to use, from env.
 *   LLM_PROVIDER = "anthropic" | "openrouter"   (optional; if unset: whichever key exists, Anthropic first when both do)
 *   anthropic : ANTHROPIC_API_KEY [, ANTHROPIC_BASE_URL]         model = PRO_CONFIG.model
 *   openrouter: OPENROUTER_API_KEY, OPENROUTER_MODEL [, OPENROUTER_BASE_URL, OPENROUTER_REFERER, OPENROUTER_TITLE]
 * OPENROUTER_MODEL has no default on purpose: OpenRouter's slug for the model must be copied from openrouter.ai/models, not guessed.
 * A misconfiguration returns llm:null with the reason (the route then serves Tier 1 text and logs why); it never throws.
 */
export function chooseLlm(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): ProviderChoice {
  const forced = env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced && forced !== "anthropic" && forced !== "openrouter") return { llm: null, provider: null, reason: `LLM_PROVIDER must be "anthropic" or "openrouter", got "${forced}"` };
  const provider: Provider | null = (forced as Provider | undefined) ?? (env.ANTHROPIC_API_KEY ? "anthropic" : env.OPENROUTER_API_KEY ? "openrouter" : null);
  if (!provider) return { llm: null, provider: null, reason: "no ANTHROPIC_API_KEY or OPENROUTER_API_KEY" };
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return { llm: null, provider, reason: "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set" };
    return { llm: createAnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined }), provider, expectedModel: PRO_CONFIG.model };
  }
  if (!env.OPENROUTER_API_KEY) return { llm: null, provider, reason: "LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is not set" };
  const model = env.OPENROUTER_MODEL?.trim();
  if (!model) return { llm: null, provider, reason: "OPENROUTER_MODEL is not set (copy the model slug from openrouter.ai/models)" };
  return {
    llm: createOpenRouterLlm({ apiKey: env.OPENROUTER_API_KEY, model, baseURL: env.OPENROUTER_BASE_URL || undefined, referer: env.OPENROUTER_REFERER, title: env.OPENROUTER_TITLE, fetchImpl }),
    provider,
    expectedModel: model,
  };
}
