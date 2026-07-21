/**
 * Deterministic token estimation and cost projection.
 *
 * Estimates are shown before any paid operation, so they must be computed
 * locally and instantly. This is a heuristic tuned to be slightly conservative
 * (over- rather than under-estimating), because the failure mode of an
 * underestimate is an unexpected charge.
 */

import type { TokenEstimator } from '../ports/index.js';

/**
 * Published prices in US dollars per million tokens.
 * Update alongside model changes; unknown models fall back to the deep tier so
 * an unrecognised id never produces a misleadingly cheap estimate.
 */
interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

const PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
};

const FALLBACK_PRICING: ModelPricing = { inputPerMTok: 5, outputPerMTok: 25 };

/**
 * Characters per token by script. English prose averages near 3.8; code and
 * dense punctuation tokenize worse; CJK is roughly one token per character.
 */
const CHARS_PER_TOKEN_PROSE = 3.8;
const CHARS_PER_TOKEN_CODE = 3.1;

const CJK_RE = /[　-鿿가-힯＀-￯]/g;
const CODE_HINT_RE = /[{}()[\];=<>|&_$]/g;

export class HeuristicTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    if (text === '') return 0;

    const cjkMatches = text.match(CJK_RE);
    const cjkCount = cjkMatches?.length ?? 0;
    const remaining = text.length - cjkCount;

    // Punctuation density separates code-like text from prose.
    const symbolCount = (text.match(CODE_HINT_RE) ?? []).length;
    const symbolRatio = text.length === 0 ? 0 : symbolCount / text.length;
    const charsPerToken =
      symbolRatio > 0.06 ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_PROSE;

    // CJK characters are counted near 1:1; the rest by the ratio above.
    const estimated = cjkCount + Math.ceil(remaining / charsPerToken);

    // Every message carries a small structural overhead.
    return estimated + 8;
  }

  estimateCostUsd(inputTokens: number, outputTokens: number, model: string): number {
    const pricing = PRICING[model] ?? FALLBACK_PRICING;
    const cost =
      (inputTokens / 1_000_000) * pricing.inputPerMTok +
      (outputTokens / 1_000_000) * pricing.outputPerMTok;
    // Round up to the cent so displayed totals never understate the charge.
    return Math.ceil(cost * 10_000) / 10_000;
  }
}

export const tokenEstimator = new HeuristicTokenEstimator();

/** Typical usable context, used to express a package as a percentage. */
export const CONTEXT_WINDOW_TOKENS = 200_000;

export interface ContextBudget {
  readonly tokens: number;
  readonly percentOfContext: number;
  readonly estimatedCostUsd: number;
}

export function describeBudget(
  tokens: number,
  model: string,
  expectedOutputTokens = 1_000,
): ContextBudget {
  return {
    tokens,
    percentOfContext: Math.round((tokens / CONTEXT_WINDOW_TOKENS) * 1000) / 10,
    estimatedCostUsd: tokenEstimator.estimateCostUsd(tokens, expectedOutputTokens, model),
  };
}

export function knownModels(): readonly string[] {
  return Object.keys(PRICING);
}
