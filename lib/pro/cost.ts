import { PRO_CONFIG } from "./config";

/** Dollar cost of `attempts` model calls. Each retry resends the whole conversation so far (input grows by the previous answer + the retry message). */
export function callCostUsd(args: { inTokens: number; outTokens: number; retryTokens?: number; attempts: number }): number {
  const { inTokens, outTokens, attempts } = args;
  const retry = args.retryTokens ?? 0;
  let tin = 0;
  for (let k = 0; k < attempts; k++) tin += inTokens + k * (outTokens + retry);
  const tout = attempts * outTokens;
  const p = PRO_CONFIG.pricing;
  return (tin * p.pricePerMTokIn + tout * p.pricePerMTokOut) / 1e6;
}

export const estimateTokens = (chars: number): number => Math.ceil(chars / PRO_CONFIG.costEstimate.charsPerToken);
