/**
 * OPTIONAL live check against a real model provider. Skipped unless AI_LIVE_TEST=1 and the usual
 * AI_PROVIDER / AI_MODEL / AI_API_KEY (and AI_BASE_URL when needed) are set. It spends a few
 * tokens and verifies the one thing mocks cannot: that the configured provider accepts our tool
 * definitions and returns a well-formed structured tool call.
 *
 *   AI_LIVE_TEST=1 AI_PROVIDER=anthropic AI_MODEL=<model> AI_API_KEY=<key> npx vitest run src/__tests__/ai/live-provider.test.ts
 */
import { describe, expect, it } from 'vitest';
import { loadAiConfig } from '../../modules/ai/config.js';
import { createModelProvider } from '../../modules/ai/providers/index.js';

const config = loadAiConfig();
const live = process.env.AI_LIVE_TEST === '1' && config.enabled;

describe.skipIf(!live)('live model provider', () => {
  it('returns a structured tool call for a trivial tool', async () => {
    const provider = createModelProvider(config);
    const response = await provider.complete({
      system: 'You must call the tool when the user asks for the time. Do not answer in text.',
      messages: [{ role: 'user', content: 'What time is it? Use the tool.' }],
      tools: [{ name: 'get_time', description: 'Returns the current time.', parameters: { type: 'object', properties: {} } }],
      maxOutputTokens: 200,
    });
    expect(response.toolCalls[0]?.name).toBe('get_time');
    expect(response.toolCalls[0]?.arguments).toBeTypeOf('object');
  }, 60_000);
});
