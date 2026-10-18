/**
 * Real-world gateways (OpenRouter-style aggregators, free-model proxies, reasoning models) deviate
 * from OpenAI's exact response shape. These tests pin the tolerant behaviour.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider, parseResponse } from '../../modules/ai/providers/openai-compatible.js';
import { ModelError } from '../../modules/ai/providers/types.js';

const reply = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ choices: [{ message, finish_reason: 'stop' }], ...extra });

describe('parseResponse tolerance', () => {
  it('reads content given as an array of parts', () => {
    const out = parseResponse(reply({ role: 'assistant', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] }));
    expect(out.text).toBe('Hello world');
  });

  it('drops inlined reasoning blocks (<think>…</think>), including an unmatched closing tag', () => {
    expect(parseResponse(reply({ content: '<think>let me reason\nabout it</think>\n\nThe answer is 4.' })).text).toBe('The answer is 4.');
    expect(parseResponse(reply({ content: 'private chain of thought</think>Final answer.' })).text).toBe('Final answer.');
    expect(parseResponse(reply({ content: 'No reasoning here.' })).text).toBe('No reasoning here.');
  });

  it('accepts a response without usage, null content with tool calls, object arguments and missing call ids', () => {
    const out = parseResponse(reply({ content: null, tool_calls: [{ function: { name: 'list_storage_accounts', arguments: { a: 1 } } }] }));
    expect(out.usage).toBeNull();
    expect(out.stopReason).toBe('tool_use');
    expect(out.toolCalls).toEqual([{ id: 'call_0', name: 'list_storage_accounts', arguments: { a: 1 }, rawArguments: '{"a":1}' }]);
  });

  it('keeps invalid JSON arguments as undefined instead of throwing', () => {
    const out = parseResponse(reply({ content: '', tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{not json' } }] }));
    expect(out.toolCalls[0].arguments).toBeUndefined();
  });

  it('still rejects a response with no choices', () => {
    expect(() => parseResponse({ choices: [] })).toThrow(ModelError);
  });
});

describe('error classification against a gateway', () => {
  let server: Server;
  let base = '';
  let next: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(next.status, { 'content-type': 'application/json' }).end(JSON.stringify(next.body)));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const call = () =>
    new OpenAiCompatibleProvider({ model: 'auto', apiKey: 'k', baseUrl: base, timeoutMs: 5000, maxRetries: 0 }).complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
      maxOutputTokens: 16,
    });

  it('reports a model that rejects tools as MODEL_NO_TOOLS with an actionable message', async () => {
    next = { status: 400, body: { error: { message: 'This model does not support tools' } } };
    await expect(call()).rejects.toMatchObject({ code: 'MODEL_NO_TOOLS' });
    next = { status: 422, body: { error: { message: "Unrecognized request argument supplied: tool_choice" } } };
    await expect(call()).rejects.toMatchObject({ code: 'MODEL_NO_TOOLS' });
  });

  it('keeps other bad requests as MODEL_BAD_REQUEST', async () => {
    next = { status: 400, body: { error: { message: 'max_tokens is too large' } } };
    await expect(call()).rejects.toMatchObject({ code: 'MODEL_BAD_REQUEST' });
  });
});
