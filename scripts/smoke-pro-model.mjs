// ONE real call through the production code path (the provider chosen from env: Anthropic direct, or OpenRouter; + SYSTEM_PROMPT + output schema),
// then the production validator. Exits non-zero, loudly, on: no key, API error, wrong model echoed, empty output, schema violation,
// or ANY validator rejection (numeric token, id, pinned move, imperative, claim, topic, url).
//   ANTHROPIC_API_KEY=sk-ant-... npm run smoke:pro
//   OPENROUTER_API_KEY=sk-or-... OPENROUTER_MODEL=<slug from openrouter.ai/models> npm run smoke:pro      (LLM_PROVIDER=openrouter to force it)
// This is the only place the real model id is exercised. It costs about a twentieth of a cent.
import { performance } from "node:perf_hooks";

const { PRO_CONFIG } = await import("../lib/pro/config.ts");
const { callCostUsd } = await import("../lib/pro/cost.ts");
const { chooseLlm } = await import("../lib/pro/provider.ts");
const { buildUserMessage, SYSTEM_PROMPT } = await import("../lib/pro/prompt.ts");
const { LlmOutputSchema, PhrasingPayloadSchema } = await import("../lib/pro/schema.ts");
const { validatePhrasing, describeViolations } = await import("../lib/pro/validate.ts");
const { THREE_FINDINGS } = await import("../tests/pro/helpers.ts");

const fail = (code, msg) => {
  console.error(`\nSMOKE FAILED: ${msg}`);
  process.exit(code);
};

const choice = chooseLlm(process.env);
if (!choice.llm) fail(2, `${choice.reason}. Nothing was called; nothing is verified.`);
const { llm, provider, expectedModel } = choice;

const payload = THREE_FINDINGS();
const parsedPayload = PhrasingPayloadSchema.safeParse(payload);
if (!parsedPayload.success) fail(1, `the smoke payload itself is invalid: ${parsedPayload.error.message}`);

const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), 30_000);
const t0 = performance.now();
let completion;
try {
  completion = await llm.complete({ system: SYSTEM_PROMPT, messages: [{ role: "user", content: buildUserMessage(payload) }], signal: ctl.signal });
} catch (e) {
  fail(1, `API call failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
} finally {
  clearTimeout(timer);
}
const latencyMs = Math.round(performance.now() - t0);

const problems = [];
const usage = completion.usage ?? { inputTokens: 0, outputTokens: 0 };
// Anthropic direct: ids are pinned snapshots, so the echo must match exactly. OpenRouter may echo a dated/variant slug of the requested one.
const modelOk = provider === "anthropic" ? completion.model === expectedModel : typeof completion.model === "string" && (completion.model === expectedModel || completion.model.startsWith(`${expectedModel}-`) || completion.model.startsWith(`${expectedModel}:`));
if (!modelOk) problems.push(`WRONG MODEL: asked for "${expectedModel}", API says it ran "${completion.model}"`);
if (!completion.text || completion.text.trim() === "") problems.push("EMPTY OUTPUT");

let raw;
let schemaOk = false;
if (completion.text) {
  try {
    raw = JSON.parse(completion.text);
    const s = LlmOutputSchema.safeParse(raw);
    schemaOk = s.success;
    if (!s.success) problems.push(`SCHEMA VIOLATION: ${s.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  } catch {
    problems.push("SCHEMA VIOLATION: output is not valid JSON");
  }
}
let validatorOk = false;
let violations = "";
if (schemaOk) {
  const v = validatePhrasing(payload, raw);
  validatorOk = v.ok;
  if (!v.ok) {
    violations = describeViolations(v.violations);
    problems.push(`VALIDATOR REJECTED THE OUTPUT (this is what would trigger a retry in production):\n${violations}`);
  }
}

const typical = callCostUsd({ inTokens: usage.inputTokens, outTokens: usage.outputTokens, attempts: 1 });
console.log("provider              :", provider);
console.log("model requested        :", expectedModel);
console.log("model echoed by API    :", completion.model);
console.log("prompt tokens (real)   :", usage.inputTokens);
console.log("completion tokens (real):", usage.outputTokens);
console.log("latency                :", `${latencyMs} ms`);
console.log("schema respected       :", schemaOk);
console.log("passed validate.ts     :", validatorOk);
console.log("cost of this call      :", `$${typical.toFixed(6)} (at $${PRO_CONFIG.pricing.pricePerMTokIn}/$${PRO_CONFIG.pricing.pricePerMTokOut} per MTok)`);
console.log("price this with scripts/pro-cost.ts:", `npx tsx scripts/pro-cost.ts ${usage.inputTokens} ${usage.outputTokens}`);
if (raw) console.log("output:\n" + JSON.stringify(raw, null, 2));
if (problems.length) fail(1, problems.join("\n"));
console.log("\nSMOKE PASSED: real model, schema respected, validator accepted the output.");
