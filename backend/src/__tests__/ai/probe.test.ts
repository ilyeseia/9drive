import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeModel } from '../../modules/ai/profiles.js';

let server: Server;
let base = '';
const seen: Array<{ auth: string | undefined; body: any }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ auth: req.headers.authorization, body });
      if (req.headers.authorization !== 'Bearer good-key') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      if (body.model === 'missing') {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no such model' } }));
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('probeModel against a real HTTP endpoint', () => {
  it('succeeds with a good key and sends a tool-less request', async () => {
    const result = await probeModel({ provider: 'openai_compatible', model: 'auto', baseUrl: base, apiKey: 'good-key' });
    expect(result).toMatchObject({ ok: true, code: null, model: 'auto' });
    expect(seen.at(-1)?.body.model).toBe('auto');
    expect(seen.at(-1)?.body.tools).toBeUndefined();
  });

  it('maps a wrong key and an unknown model to error codes, without retrying', async () => {
    seen.length = 0;
    expect(await probeModel({ provider: 'openai_compatible', model: 'auto', baseUrl: base, apiKey: 'wrong' })).toMatchObject({ ok: false, code: 'MODEL_AUTH' });
    expect(seen).toHaveLength(1);
    expect(await probeModel({ provider: 'openai_compatible', model: 'missing', baseUrl: base, apiKey: 'good-key' })).toMatchObject({ ok: false, code: 'MODEL_NOT_FOUND' });
  });

  it('reports an unreachable endpoint as unavailable', async () => {
    const result = await probeModel({ provider: 'openai_compatible', model: 'auto', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MODEL_UNAVAILABLE');
  });
});
