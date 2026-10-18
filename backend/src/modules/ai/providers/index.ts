import type { AiConfig } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { ModelError, type ModelProvider } from './types.js';

export * from './types.js';

/** Builds the configured provider. There is deliberately no fallback to another vendor/model. */
export function createModelProvider(config: AiConfig): ModelProvider {
  if (!config.enabled || !config.provider || !config.model) {
    throw new ModelError('MODEL_UNAVAILABLE', config.reason ?? 'The AI assistant is not configured.');
  }
  if (config.provider === 'anthropic') {
    return new AnthropicProvider({
      model: config.model,
      apiKey: config.apiKey ?? '',
      baseUrl: config.baseUrl,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
    });
  }
  return new OpenAiCompatibleProvider({
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
  });
}
