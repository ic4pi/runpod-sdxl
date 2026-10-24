import { PRO_CONFIG } from "./config";
import { LlmError, type LlmClient } from "./llm";
import { looseOutputJsonSchema } from "./prompt";

/**
 * Anthropic models through OpenRouter (https://openrouter.ai), using its OpenAI-compatible chat-completions API with JSON-schema structured
 * output. Plain fetch, no SDK. Same contract as the direct client: one request per attempt, our own retry loop and validator decide what is
 * accepted. NOT yet run against the real OpenRouter (no key, and this build environment cannot reach it): tested against a local stub.
 *
 * Request: POST {baseURL}/chat/completions, Authorization: Bearer <key>, body { model, max_tokens, messages: [system, ...turns],
 * response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }, provider: { require_parameters: true } }.
 * `require_parameters` makes OpenRouter route only to providers that honour response_format, instead of silently dropping it.
 */
export function createOpenRouterLlm(opts: { apiKey: string; model: string; baseURL?: string; referer?: string; title?: string; fetchImpl?: typeof fetch }): LlmClient {
  const url = `${(opts.baseURL ?? PRO_CONFIG.openrouter.baseURL).replace(/\/+$/, "")}/chat/completions`;
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    modelId: opts.model,
    async complete({ system, messages, signal }) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "content-type": "application/json",
            ...(opts.referer ? { "http-referer": opts.referer } : {}),
            ...(opts.title ? { "x-title": opts.title } : {}),
          },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: PRO_CONFIG.maxOutputTokens,
            messages: [{ role: "system", content: system }, ...messages],
            response_format: { type: "json_schema", json_schema: { name: "phrasing", strict: true, schema: looseOutputJsonSchema() } },
            provider: { require_parameters: true },
          }),
          signal,
        });
      } catch (e) {
        throw new LlmError(`OpenRouter unreachable: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      const body = (await res.json().catch(() => null)) as OpenRouterBody | null;
      if (!res.ok || body?.error) {
        const status = res.ok ? (body?.error?.code ?? 502) : res.status;
        const msg = body?.error?.message ?? `HTTP ${res.status}`;
        // 401 bad key, 402 no credits, 403 blocked, 400/404/422 bad request or model id: retrying cannot help. 408/429/5xx can.
        const retryable = status === 408 || status === 429 || (typeof status === "number" && status >= 500);
        throw new LlmError(`OpenRouter ${status}: ${String(msg).slice(0, 160)}`, retryable);
      }
      const choice = body?.choices?.[0];
      if (choice?.finish_reason === "length") throw new LlmError("output hit max_tokens", true);
      if (choice?.finish_reason === "content_filter" || choice?.message?.refusal) throw new LlmError("model refused", false);
      const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
      return {
        text,
        model: body?.model,
        usage: { inputTokens: body?.usage?.prompt_tokens ?? 0, outputTokens: body?.usage?.completion_tokens ?? 0 },
      };
    },
  };
}

interface OpenRouterBody {
  model?: string;
  error?: { code?: number; message?: string };
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
