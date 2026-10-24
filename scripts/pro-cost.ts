// Prints the Pro phrasing cost model for a typical 3-finding request. Token counts are ESTIMATES (chars / charsPerToken) until a real call reports them.
//   npx tsx scripts/pro-cost.ts [realInTokens realOutTokens]   <- pass the smoke call's real counts to price those instead
import { callCostUsd, estimateTokens } from "../lib/pro/cost";
import { PRO_CONFIG } from "../lib/pro/config";
import { tier1FallbackItems } from "../lib/pro/findings";
import { buildRetryMessage, buildUserMessage, outputJsonSchema, SYSTEM_PROMPT } from "../lib/pro/prompt";
import { THREE_FINDINGS } from "../tests/pro/helpers";

const p = THREE_FINDINGS();
const argIn = Number(process.argv[2]);
const argOut = Number(process.argv[3]);
const real = Number.isFinite(argIn) && Number.isFinite(argOut) && argIn > 0 && argOut > 0;
const inChars = SYSTEM_PROMPT.length + JSON.stringify(outputJsonSchema()).length + buildUserMessage(p).length;
const outChars = JSON.stringify({ items: tier1FallbackItems(p).map((i) => ({ ...i, explanation: `${i.explanation} ${i.explanation.slice(0, 80)}` })) }).length;
const retryChars = buildRetryMessage([{ kind: "number", detail: '"777" (dB) is not a dB number in the input', field: "items[0].explanation" }]).length;
const inTokens = real ? argIn : estimateTokens(inChars);
const outTokens = real ? argOut : estimateTokens(outChars);
const retryTokens = estimateTokens(retryChars);
const label = real ? "REAL token counts from a live call" : `ESTIMATED tokens (chars / ${PRO_CONFIG.costEstimate.charsPerToken})`;
const typical = callCostUsd({ inTokens, outTokens, attempts: 1 });
const worst = callCostUsd({ inTokens, outTokens, retryTokens, attempts: 1 + PRO_CONFIG.maxRetries });
console.log(JSON.stringify({ model: PRO_CONFIG.model, tokens: label, inTokens, outTokens, retryTokens, price: PRO_CONFIG.pricing, usdPerCallTypical: typical, usdPerCallWorst3Attempts: worst, usdPer1000Typical: +(typical * 1000).toFixed(4), usdPer1000Worst: +(worst * 1000).toFixed(4), note: "prices are Anthropic direct list prices; OpenRouter passes provider prices through but adds its own credit-purchase fee and its slug may be priced differently: check openrouter.ai/models. Excludes any thinking tokens (billed as output) and structured-output schema overhead: unmeasured" }, null, 2));
