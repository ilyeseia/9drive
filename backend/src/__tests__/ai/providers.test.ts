import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAiConfig, publicAiStatus } from '../../modules/ai/config.js';
import { createModelProvider, ModelError } from '../../modules/ai/providers/index.js';
import { AnthropicProvider } from '../../modules/ai/providers/anthropic.js';
import { OpenAiCompatibleProvider, parseResponse } from '../../modules/ai/providers/openai-compatible.js';
import type { ModelRequest } from '../../modules/ai/providers/types.js';

interface Recorded {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, any>;
}

let server: Server | null = null;

async function startServer(handler: (req: Recorded, n: number) => { status: number; body: unknown; headers?: Record<string, string>; hang?: boolean }) {
  const calls: Recorded[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: Recorded = { url: req.url ?? '', headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') };
      calls.push(recorded);
      const out = handler(recorded, calls.length);
      if (out.hang) return;
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server!.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const request: ModelRequest = {
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'list_storage_accounts', description: 'd', parameters: { type: 'object', properties: {} } }],
  maxOutputTokens: 100,
};
const noSleep = async () => undefined;

const okOpenAi = {
  choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

describe('AI configuration', () => {
  it('is disabled with an explicit reason when nothing is configured', () => {
    const config = loadAiConfig({});
    expect(config.enabled).toBe(false);
    expect(config.reason).toContain('AI_PROVIDER');
  });

  it('reports missing model, missing key, bad provider and bad URL precisely', () => {
    expect(loadAiConfig({ AI_PROVIDER: 'openai_compatible' }).reason).toBe('AI_MODEL is not set.');
    expect(loadAiConfig({ AI_PROVIDER: 'anthropic', AI_MODEL: 'm' }).reason).toBe('AI_API_KEY is not set.');
    expect(loadAiConfig({ AI_PROVIDER: 'nope', AI_MODEL: 'm' }).reason).toContain('not supported');
    expect(loadAiConfig({ AI_PROVIDER: 'openai_compatible', AI_MODEL: 'm', AI_API_KEY: 'k', AI_BASE_URL: 'ftp://x' }).reason).toContain('AI_BASE_URL');
    expect(loadAiConfig({ AI_PROVIDER: 'openai_compatible', AI_MODEL: 'm', AI_API_KEY: 'k', AI_BASE_URL: 'https://u:p@x.example' }).enabled).toBe(false);
  });

  it('allows keyless self-hosted OpenAI-compatible servers only', () => {
    expect(loadAiConfig({ AI_PROVIDER: 'openai_compatible', AI_MODEL: 'llama', AI_BASE_URL: 'http://localhost:11434/v1' }).enabled).toBe(true);
    expect(loadAiConfig({ AI_PROVIDER: 'openai_compatible', AI_MODEL: 'gpt' }).enabled).toBe(false);
    expect(loadAiConfig({ AI_PROVIDER: 'anthropic', AI_MODEL: 'm', AI_BASE_URL: 'http://x' }).enabled).toBe(false);
  });

  it('clamps invalid numeric limits to safe defaults and never exposes the key', () => {
    const config = loadAiConfig({ AI_PROVIDER: 'anthropic', AI_MODEL: 'm', AI_API_KEY: 'sk-secret-1234567890', AI_MAX_STEPS: '9999', AI_MAX_RETRIES: 'abc' });
    expect(config.maxSteps).toBe(8);
    expect(config.maxRetries).toBe(2);
    expect(JSON.stringify(publicAiStatus(config))).not.toContain('sk-secret');
  });

  it('refuses to build a provider when disabled (no silent fallback)', () => {
    expect(() => createModelProvider(loadAiConfig({}))).toThrow(ModelError);
  });
});

describe('OpenAI-compatible adapter', () => {
  it('sends tools, bearer auth and parses text, usage and stop reason', async () => {
    const { base, calls } = await startServer(() => ({ status: 200, body: okOpenAi }));
    const provider = new OpenAiCompatibleProvider({ model: 'm', apiKey: 'KEY', baseUrl: `${base}/v1`, timeoutMs: 2000, maxRetries: 0 });
    const result = await provider.complete(request);
    expect(result).toMatchObject({ text: 'hello', stopReason: 'end', usage: { inputTokens: 10, outputTokens: 5 }, toolCalls: [] });
    expect(calls[0].url).toBe('/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer KEY');
    expect(calls[0].body.tools[0].function.name).toBe('list_storage_accounts');
    expect(calls[0].body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(calls[0].body.max_tokens).toBe(100);
  });

  it('parses tool calls and maps invalid argument JSON to undefined (never executed as text)', async () => {
    const { base } = await startServer(() => ({
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'a', function: { name: 'search_files', arguments: '{"query":"pdf"}' } },
                { id: 'b', function: { name: 'search_files', arguments: '{not json' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    }));
    const provider = new OpenAiCompatibleProvider({ model: 'm', apiKey: null, baseUrl: base, timeoutMs: 2000, maxRetries: 0 });
    const result = await provider.complete(request);
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls[0]).toMatchObject({ id: 'a', name: 'search_files', arguments: { query: 'pdf' } });
    expect(result.toolCalls[1].arguments).toBeUndefined();
  });

  it('retries 429/5xx with Retry-After up to the bound, then succeeds', async () => {
    const delays: number[] = [];
    const { base, calls } = await startServer((_r, n) =>
      n < 3 ? { status: n === 1 ? 429 : 503, body: { error: { message: 'busy' } }, headers: (n === 1 ? { 'retry-after': '2' } : {}) as Record<string, string> } : { status: 200, body: okOpenAi },
    );
    const provider = new OpenAiCompatibleProvider({
      model: 'm', apiKey: 'k', baseUrl: base, timeoutMs: 2000, maxRetries: 2,
      sleep: async (ms) => void delays.push(ms),
    });
    expect((await provider.complete(request)).text).toBe('hello');
    expect(calls).toHaveLength(3);
    expect(delays[0]).toBe(2000);
  });

  it('stops after maxRetries and reports a rate-limit error', async () => {
    const { base, calls } = await startServer(() => ({ status: 429, body: { error: { message: 'slow down' } } }));
    const provider = new OpenAiCompatibleProvider({ model: 'm', apiKey: 'k', baseUrl: base, timeoutMs: 2000, maxRetries: 1, sleep: noSleep });
    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'MODEL_RATE_LIMITED' });
    expect(calls).toHaveLength(2);
  });

  it('does not retry auth or model-not-found errors and never leaks the key', async () => {
    const { base, calls } = await startServer(() => ({ status: 401, body: { error: { message: 'bad key sk-live-abcdefghijklmnop' } } }));
    const provider = new OpenAiCompatibleProvider({ model: 'm', apiKey: 'sk-live-abcdefghijklmnop', baseUrl: base, timeoutMs: 2000, maxRetries: 3, sleep: noSleep });
    const error = await provider.complete(request).catch((e: unknown) => e as ModelError);
    expect(error).toMatchObject({ code: 'MODEL_AUTH' });
    expect(String((error as Error).message)).not.toContain('sk-live');
    expect(calls).toHaveLength(1);

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const nf = await startServer(() => ({ status: 404, body: { error: { message: 'model gone' } } }));
    const p2 = new OpenAiCompatibleProvider({ model: 'm', apiKey: 'k', baseUrl: nf.base, timeoutMs: 2000, maxRetries: 3, sleep: noSleep });
    await expect(p2.complete(request)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    expect(nf.calls).toHaveLength(1);
  });

  it('rejects malformed responses and non-JSON bodies', async () => {
    expect(() => parseResponse({ choices: [] })).toThrow(ModelError);
    expect(() => parseResponse({ choices: [{ message: { tool_calls: [{ function: {} }] } }] })).toThrow(ModelError);
    const { base } = await startServer(() => ({ status: 200, body: 'not json at all' }));
    const provider = new OpenAiCompatibleProvider({ model: 'm', apiKey: 'k', baseUrl: base, timeoutMs: 2000, maxRetries: 0 });
    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'MODEL_BAD_RESPONSE' });
  });

  it('times out and supports cancellation without retrying a cancelled call', async () => {
    const { base } = await startServer(() => ({ status: 200, body: {}, hang: true }));
    const slow = new OpenAiCompatibleProvider({ model: 'm', apiKey: 'k', baseUrl: base, timeoutMs: 150, maxRetries: 0 });
    await expect(slow.complete(request)).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });

    const controller = new AbortController();
    const provider = new OpenAiCompatibleProvider({ model: 'm', apiKey: 'k', baseUrl: base, timeoutMs: 5000, maxRetries: 3, sleep: noSleep });
    const pending = provider.complete({ ...request, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
  });

  it('reports an unreachable server as retryable MODEL_UNAVAILABLE', async () => {
    const provider = new OpenAiCompatibleProvider({ model: 'm', apiKey: 'k', baseUrl: 'http://127.0.0.1:1', timeoutMs: 500, maxRetries: 0 });
    await expect(provider.complete(request)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true });
  });
});

describe('Anthropic adapter', () => {
  it('uses x-api-key, maps tools to input_schema and merges consecutive tool results', async () => {
    const { base, calls } = await startServer(() => ({
      status: 200,
      body: {
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'tu1', name: 'search_files', input: { query: 'pdf' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    }));
    const provider = new AnthropicProvider({ model: 'm', apiKey: 'AKEY', baseUrl: base, timeoutMs: 2000, maxRetries: 0 });
    const result = await provider.complete({
      ...request,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'working',
          toolCalls: [
            { id: 't1', name: 'a', arguments: { x: 1 }, rawArguments: '{"x":1}' },
            { id: 't2', name: 'b', arguments: {}, rawArguments: '{}' },
          ],
        },
        { role: 'tool', content: 'r1', toolCallId: 't1' },
        { role: 'tool', content: 'r2', toolCallId: 't2' },
      ],
    });
    expect(result).toMatchObject({ text: 'checking', stopReason: 'tool_use', usage: { inputTokens: 7, outputTokens: 3 } });
    expect(result.toolCalls[0]).toMatchObject({ id: 'tu1', name: 'search_files', arguments: { query: 'pdf' } });
    expect(calls[0].headers['x-api-key']).toBe('AKEY');
    expect(calls[0].headers['anthropic-version']).toBeTruthy();
    expect(calls[0].body.tools[0].input_schema).toBeDefined();
    const wire = calls[0].body.messages;
    expect(wire).toHaveLength(3);
    expect(wire[2].content.map((b: any) => b.tool_use_id)).toEqual(['t1', 't2']);
    expect(wire[1].content.some((b: any) => b.type === 'tool_use' && b.id === 't1')).toBe(true);
  });

  it('maps stop reasons and rejects malformed content', async () => {
    const { base } = await startServer(() => ({ status: 200, body: { content: [{ type: 'text', text: 'cut' }], stop_reason: 'max_tokens' } }));
    const provider = new AnthropicProvider({ model: 'm', apiKey: 'k', baseUrl: base, timeoutMs: 2000, maxRetries: 0 });
    expect((await provider.complete(request)).stopReason).toBe('length');
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const bad = await startServer(() => ({ status: 200, body: { nope: true } }));
    const p2 = new AnthropicProvider({ model: 'm', apiKey: 'k', baseUrl: bad.base, timeoutMs: 2000, maxRetries: 0 });
    await expect(p2.complete(request)).rejects.toMatchObject({ code: 'MODEL_BAD_RESPONSE' });
  });
});
