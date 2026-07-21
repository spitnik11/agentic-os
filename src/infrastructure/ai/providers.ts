/**
 * Language model adapters.
 *
 * The NoOp provider is the default and refuses every request with a structured
 * reason the UI can display. No network client is constructed unless AI is
 * explicitly enabled and a key is present, so the shipped default cannot make
 * an outbound call even by mistake.
 */

import { allowsExternalModel, redact, requiresRedaction } from '../../domain/policy/privacy.js';
import { tokenEstimator } from '../../domain/tokens/estimator.js';
import type {
  AnalysisRequest,
  AnalysisResult,
  LanguageModelProvider,
  UsageRepository,
} from '../../domain/ports/index.js';

export class NoOpLanguageModelProvider implements LanguageModelProvider {
  readonly name = 'none';
  readonly available = false;

  private readonly reason: 'ai_disabled' | 'no_credentials';

  constructor(reason: 'ai_disabled' | 'no_credentials' = 'ai_disabled') {
    this.reason = reason;
  }

  analyze(_request: AnalysisRequest): Promise<AnalysisResult> {
    return Promise.resolve({
      ok: false,
      reason: this.reason,
      detail:
        this.reason === 'ai_disabled'
          ? 'AI is turned off. Every feature outside Token Class 0 is unavailable until you enable it in Settings.'
          : 'No ANTHROPIC_API_KEY is configured. Add one to .env.local to enable analysis.',
    });
  }
}

export interface ClaudeProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly monthlyBudgetUsd: number;
  readonly perRunTokenCeiling: number;
  readonly usage: UsageRepository;
  readonly feature: string;
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export class ClaudeLanguageModelProvider implements LanguageModelProvider {
  readonly name = 'claude';
  readonly available = true;

  constructor(private readonly options: ClaudeProviderOptions) {}

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    // 1. Privacy gate. Checked here as well as at the call site, because this is
    //    the last point before content would leave the machine.
    if (!allowsExternalModel(request.privacy)) {
      return {
        ok: false,
        reason: 'privacy_blocked',
        detail: `Content is classified '${request.privacy}' and may not be sent to an external model.`,
      };
    }

    // 2. Budget gate.
    const spent = this.options.usage.monthToDateUsd();
    if (spent >= this.options.monthlyBudgetUsd) {
      return {
        ok: false,
        reason: 'budget_exceeded',
        detail: `Month-to-date spend of $${spent.toFixed(4)} has reached the $${this.options.monthlyBudgetUsd.toFixed(2)} limit.`,
      };
    }

    // 3. Redact, then size the request.
    let prompt = request.prompt;
    let redactionNote = '';
    if (requiresRedaction(request.privacy)) {
      const result = redact(prompt);
      prompt = result.text;
      if (result.redactions.length > 0) {
        redactionNote = ` (${result.redactions.reduce((n, r) => n + r.count, 0)} value(s) redacted)`;
      }
    }

    const estimatedInput = tokenEstimator.estimate(prompt) + tokenEstimator.estimate(request.system ?? '');
    if (estimatedInput > this.options.perRunTokenCeiling) {
      return {
        ok: false,
        reason: 'token_ceiling_exceeded',
        detail: `This request is about ${estimatedInput.toLocaleString()} input tokens, above the per-run ceiling of ${this.options.perRunTokenCeiling.toLocaleString()}. Narrow the selection.`,
      };
    }

    // 4. Call.
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: request.maxOutputTokens ?? 2048,
          ...(request.system === undefined ? {} : { system: request.system }),
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          ok: false,
          reason: 'provider_error',
          detail: `Provider returned ${response.status}: ${body.slice(0, 300)}`,
        };
      }

      const payload = (await response.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const text = (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

      const inputTokens = payload.usage?.input_tokens ?? estimatedInput;
      const outputTokens = payload.usage?.output_tokens ?? tokenEstimator.estimate(text);
      const cost = tokenEstimator.estimateCostUsd(inputTokens, outputTokens, this.options.model);

      // 5. Account for it. Recorded even on partial results so spend is never
      //    invisible.
      this.options.usage.record({
        feature: this.options.feature + redactionNote,
        tokenClass: request.tokenClass,
        model: this.options.model,
        inputTokens,
        outputTokens,
        costUsd: cost,
      });

      return {
        ok: true,
        text,
        usage: { inputTokens, outputTokens, estimatedCostUsd: cost, model: this.options.model },
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'provider_error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export interface ProviderFactoryOptions {
  readonly aiEnabled: boolean;
  readonly apiKey: string | undefined;
  readonly model: string;
  readonly monthlyBudgetUsd: number;
  readonly perRunTokenCeiling: number;
  readonly usage: UsageRepository;
  readonly feature: string;
}

/**
 * Select a provider. Both gates must pass: the switch and the credential.
 * This is the only place a real provider is constructed.
 */
export function createLanguageModelProvider(
  options: ProviderFactoryOptions,
): LanguageModelProvider {
  if (!options.aiEnabled) return new NoOpLanguageModelProvider('ai_disabled');
  if (options.apiKey === undefined || options.apiKey.trim() === '') {
    return new NoOpLanguageModelProvider('no_credentials');
  }
  return new ClaudeLanguageModelProvider({
    apiKey: options.apiKey,
    model: options.model,
    monthlyBudgetUsd: options.monthlyBudgetUsd,
    perRunTokenCeiling: options.perRunTokenCeiling,
    usage: options.usage,
    feature: options.feature,
  });
}
