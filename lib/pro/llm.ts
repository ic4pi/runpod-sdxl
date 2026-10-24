import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { PRO_CONFIG } from "./config";
import { LlmOutputSchema } from "./schema";

export interface LlmTurn {
  role: "user" | "assistant";
  content: string;
}
export interface LlmCompletion {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** The model id the API says it ran (`response.model`). The smoke script requires it to equal PRO_CONFIG.model. */
  model?: string;
}
/** The seam the route is tested through. Production uses the Anthropic SDK; tests inject a fake. */
export interface LlmClient {
  /** The model id this client asks for (provider-specific: "claude-haiku-5-5" on Anthropic, e.g. "anthropic/claude-haiku-5-5" on OpenRouter). Part of the cache key. */
  readonly modelId: string;
  complete(args: { system: string; messages: LlmTurn[]; signal: AbortSignal }): Promise<LlmCompletion>;
}

/**
 * Official Anthropic SDK (fetch-based, runs on the edge). One request per attempt: SDK retries are OFF so the only retries are ours,
 * where each one is validated and counted. Structured output (`output_config.format`) constrains the JSON; our own strict validation
 * still runs on the result. No assistant prefill, no forced tool_choice.
 */
export function createAnthropicLlm(opts: { apiKey: string; baseURL?: string }): LlmClient {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
  return {
    modelId: PRO_CONFIG.model,
    async complete({ system, messages, signal }) {
      const res = await client.messages.create(
        {
          model: PRO_CONFIG.model,
          max_tokens: PRO_CONFIG.maxOutputTokens,
          system,
          messages,
          output_config: { effort: PRO_CONFIG.effort, format: zodOutputFormat(LlmOutputSchema) },
        },
        { signal },
      );
      if (res.stop_reason === "refusal") throw new Error("model refused");
      if (res.stop_reason === "max_tokens") throw new Error("output hit max_tokens");
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, model: res.model, usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
    },
  };
}

/** An error from a provider. `retryable: false` (bad key, no credits, bad request) stops the handler's retry loop: another attempt cannot succeed and would only cost. */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
