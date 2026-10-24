/** Shared test harness for the /api/phrasing handler. The LLM is a SCRIPTED FAKE (no network). */
import { sha256Hex } from "../../lib/pro/hash";
import type { ProKey } from "../../lib/pro/auth";
import { handlePhrasing, type HandlerDeps } from "../../lib/pro/handler";
import type { LlmClient, LlmTurn } from "../../lib/pro/llm";
import { RateLimiter, TtlLru } from "../../lib/pro/limits";
import { tier1FallbackItems } from "../../lib/pro/findings";
import type { PhrasedItem, PhrasingPayload, PhrasingResult } from "../../lib/pro/schema";
import { PRO_CONFIG } from "../../lib/pro/config";
import { ABSENT } from "./helpers";

export const KEY = "pro-key-for-tests-123";
export const NONCE = "a".repeat(40);

export type Script = (string | Error | ((turns: LlmTurn[]) => string))[];
export class FakeLlm implements LlmClient {
  readonly modelId: string = PRO_CONFIG.model;
  calls: LlmTurn[][] = [];
  constructor(private script: Script) {}
  async complete({ messages }: { messages: LlmTurn[] }) {
    this.calls.push(messages.map((m) => ({ ...m })));
    const s = this.script[Math.min(this.calls.length - 1, this.script.length - 1)]!;
    if (s instanceof Error) throw s;
    const text = typeof s === "function" ? s(messages) : s;
    return { text, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

export const okText = (p: PhrasingPayload, tweak?: (i: PhrasedItem[]) => PhrasedItem[]) => JSON.stringify({ items: (tweak ?? ((x) => x))(reworded(p)) });
/** "Rewording" that only reuses the input's own numbers and words. */
export const reworded = (p: PhrasingPayload): PhrasedItem[] =>
  tier1FallbackItems(p).map((i) => ({ ...i, headline: i.headline, explanation: `In plain words: ${i.explanation}` }));
export const hallucinated = (p: PhrasingPayload) => okText(p, (items) => items.map((i, n) => (n === 0 ? { ...i, suggested_move: `Cut ${ABSENT} dB.` } : i)));

export async function setup(llm: LlmClient | null, over: Partial<HandlerDeps> = {}) {
  let t = 1_000_000;
  const logs: Record<string, unknown>[] = [];
  const deps: HandlerDeps = {
    llm,
    proKeys: [{ hash: await sha256Hex(KEY), label: "test-key" } satisfies ProKey],
    cache: new TtlLru<PhrasingResult>(50, 60_000),
    limiter: new RateLimiter(60_000),
    now: () => (t += 5),
    log: (e) => logs.push(e),
    ...over,
  };
  const call = (payload: PhrasingPayload, headers: Record<string, string> = {}, body?: string) =>
    handlePhrasing(
      new Request("http://x/api/phrasing", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "x-install-nonce": NONCE, "content-type": "application/json", ...headers },
        body: body ?? JSON.stringify({ payload }),
      }),
      deps,
    );
  return { deps, call, logs };
}
