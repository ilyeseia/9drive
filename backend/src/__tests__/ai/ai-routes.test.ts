import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const rt = vi.hoisted(() => ({ agent: null as any, store: null as any, registry: null as any, config: null as any }));

vi.mock('../../middleware/auth.middleware.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const user = req.header('x-test-user');
    if (!user) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Bearer token required.' });
    req.user = { id: user, sessionId: 's' };
    return next();
  },
}));
vi.mock('../../middleware/rate-limit.middleware.js', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return { aiMessageLimiter: pass, aiReadLimiter: pass, aiToolRunLimiter: pass, defaultRateLimiter: pass, apiKeyRateLimiter: pass, publicTokenLimiter: pass };
});
vi.mock('../../utils/audit.js', () => ({ createAuditLog: async () => undefined }));
vi.mock('../../modules/ai/runtime.js', () => ({
  getAgent: () => rt.agent,
  getAgentStore: () => rt.store,
  getToolRegistry: () => rt.registry,
}));
vi.mock('../../modules/ai/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/ai/config.js')>()),
  getAiConfig: () => rt.config,
}));

import { AgentOrchestrator } from '../../modules/ai/agent.js';
import { loadAiConfig } from '../../modules/ai/config.js';
import { aiRouter } from '../../modules/ai/ai.routes.js';
import { errorMiddleware } from '../../middleware/error.middleware.js';
import type { ModelProvider, ModelResponse } from '../../modules/ai/providers/types.js';
import { createMemoryStore } from '../../modules/ai/store.memory.js';
import { ToolRegistry, defineTool } from '../../modules/ai/tools/index.js';

let server: Server;
let base = '';
const executed: string[] = [];

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'list_things', domain: 'files', description: 'read', input: z.object({}), output: z.any(), risk: 'low', timeoutMs: 1000, audit: false,
      execute: async (_a, ctx) => ({ data: { owner: ctx.userId, items: ['a'] }, summary: 'listed' }),
    }),
  );
  registry.register(
    defineTool({
      name: 'trash_things', domain: 'files', description: 'trash', input: z.object({ ids: z.array(z.string()).min(1) }), output: z.any(), risk: 'medium', timeoutMs: 1000, audit: true,
      preview: async (a) => ({ summary: `Trash ${a.ids.length} item(s)`, affectedCount: a.ids.length, sample: a.ids, warnings: [] }),
      execute: async (a, ctx) => {
        executed.push(`${ctx.userId}:${a.ids.join(',')}`);
        return { data: { trashed: a.ids.length }, summary: 'trashed', verification: 're-read ok' };
      },
    }),
  );
  return registry;
}

function resetState(script: (n: number) => ModelResponse, enabled = true) {
  rt.store = createMemoryStore();
  rt.registry = makeRegistry();
  rt.config = enabled
    ? loadAiConfig({ AI_PROVIDER: 'openai_compatible', AI_MODEL: 'secret-model-x', AI_API_KEY: 'sk-super-secret-key-123456' })
    : loadAiConfig({});
  let n = 0;
  const provider: ModelProvider = { id: 'scripted', model: 'm', complete: async () => script(++n) };
  rt.agent = new AgentOrchestrator({ store: rt.store, registry: rt.registry, config: rt.config, provider: () => provider });
  executed.length = 0;
}

const say = (text: string): ModelResponse => ({ text, toolCalls: [], usage: null, stopReason: 'end' });
const trashCall = (): ModelResponse => ({ text: '', toolCalls: [{ id: 'c1', name: 'trash_things', arguments: { ids: ['a', 'b'] }, rawArguments: '' }], usage: null, stopReason: 'tool_use' });

async function api(method: string, path: string, opts: { user?: string; body?: unknown; raw?: string } = {}) {
  const response = await fetch(`${base}/ai${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.user ? { 'x-test-user': opts.user } : {}) },
    body: method === 'GET' || method === 'HEAD' ? undefined : opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, tries = 80): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('condition not reached');
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/ai', aiRouter);
  app.use(errorMiddleware);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => resetState((n) => (n === 1 ? trashCall() : say('Done.'))));

const ID = '00000000-0000-4000-8000-000000000001';

describe('authentication', () => {
  it('rejects every route without a session', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/status'], ['GET', '/capabilities'], ['GET', '/conversations'], ['POST', '/conversations'],
      ['GET', `/conversations/${ID}`], ['DELETE', `/conversations/${ID}`], ['POST', `/conversations/${ID}/messages`],
      ['GET', `/tasks/${ID}`], ['POST', `/tasks/${ID}/cancel`], ['POST', `/confirmations/${ID}/approve`],
      ['POST', `/confirmations/${ID}/reject`], ['POST', '/tools/list_things/run'],
    ];
    for (const [method, path] of routes) {
      const res = await api(method, path, { body: {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('status and capabilities', () => {
  it('never exposes the API key, base URL or secrets', async () => {
    const res = await api('GET', '/status', { user: 'u1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, provider: 'openai_compatible', model: 'secret-model-x' });
    expect(res.text).not.toContain('sk-super-secret');
    expect(res.text).not.toMatch(/apiKey|baseUrl/i);
  });

  it('reports a clear reason when AI is not configured and still serves read-only tools', async () => {
    resetState(() => say('x'), false);
    const status = await api('GET', '/status', { user: 'u1' });
    expect(status.body.enabled).toBe(false);
    expect(status.body.reason).toContain('AI_PROVIDER');
    const conv = await api('POST', '/conversations', { user: 'u1', body: {} });
    const send = await api('POST', `/conversations/${conv.body.conversation.id}/messages`, { user: 'u1', body: { text: 'hi' } });
    expect(send.status).toBe(503);
    expect(send.body.code).toBe('AI_NOT_CONFIGURED');
    const direct = await api('POST', '/tools/list_things/run', { user: 'u1', body: {} });
    expect(direct.status).toBe(200);
    expect(direct.body).toMatchObject({ ok: true, data: { owner: 'u1' } });
  });

  it('lists the tool catalogue with risk and confirmation flags', async () => {
    const res = await api('GET', '/capabilities', { user: 'u1' });
    expect(res.body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'list_things', risk: 'low', confirmation: false }),
      expect.objectContaining({ name: 'trash_things', risk: 'medium', confirmation: true, audited: true }),
    ]));
  });
});

describe('conversation isolation and validation', () => {
  it("other users cannot read, delete, post to, or see tasks of someone else's conversation", async () => {
    const conv = (await api('POST', '/conversations', { user: 'u1', body: { locale: 'ar' } })).body.conversation;
    expect(conv.locale).toBe('ar');
    expect((await api('GET', `/conversations/${conv.id}`, { user: 'u2' })).status).toBe(404);
    expect((await api('DELETE', `/conversations/${conv.id}`, { user: 'u2' })).status).toBe(404);
    expect((await api('POST', `/conversations/${conv.id}/messages`, { user: 'u2', body: { text: 'hi' } })).status).toBe(404);
    expect((await api('GET', '/conversations', { user: 'u2' })).body.conversations).toHaveLength(0);
    expect((await api('GET', `/conversations/${conv.id}`, { user: 'u1' })).status).toBe(200);

    const task = (await api('POST', `/conversations/${conv.id}/messages`, { user: 'u1', body: { text: 'trash a and b' } })).body.task;
    for (const [method, path] of [['GET', `/tasks/${task.id}`], ['POST', `/tasks/${task.id}/cancel`]] as const) {
      expect((await api(method, path, { user: 'u2' })).status, path).toBe(404);
    }
  });

  it('validates ids, message length, locale and request size', async () => {
    const conv = (await api('POST', '/conversations', { user: 'u1', body: {} })).body.conversation;
    expect((await api('GET', '/conversations/not-a-uuid', { user: 'u1' })).status).toBe(404);
    expect((await api('POST', `/conversations/${conv.id}/messages`, { user: 'u1', body: { text: '' } })).status).toBe(400);
    expect((await api('POST', `/conversations/${conv.id}/messages`, { user: 'u1', body: { text: 'x'.repeat(4001) } })).status).toBe(400);
    expect((await api('POST', `/conversations/${conv.id}/messages`, { user: 'u1', body: { text: 'hi', locale: 'xx' } })).status).toBe(400);
    expect((await api('POST', '/conversations', { user: 'u1', body: { locale: 'de' } })).status).toBe(400);
    const huge = await api('POST', `/conversations/${conv.id}/messages`, { user: 'u1', raw: JSON.stringify({ text: 'x'.repeat(20_000) }) });
    expect(huge.status).toBe(413);
  });
});

describe('end-to-end confirmation flow over HTTP', () => {
  async function propose() {
    const conv = (await api('POST', '/conversations', { user: 'u1', body: {} })).body.conversation;
    const task = (await api('POST', `/conversations/${conv.id}/messages`, { user: 'u1', body: { text: 'delete a and b' } })).body.task;
    const view = await until(() => api('GET', `/tasks/${task.id}`, { user: 'u1' }), (r) => r.body.task.status === 'AWAITING_CONFIRMATION');
    return { conv, task, view: view.body };
  }

  it('pauses with a server-generated card; nothing executes until the user approves', async () => {
    const { view } = await propose();
    expect(view.confirmation).toMatchObject({ tool: 'trash_things', risk: 'medium', summary: 'Trash 2 item(s)', status: 'PENDING' });
    expect(view.confirmation.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(view.steps[0]).toMatchObject({ tool: 'trash_things', status: 'PENDING_CONFIRMATION' });
    expect(executed).toEqual([]);
  });

  it('runs exactly once on approval, then the model summarises and the task completes', async () => {
    const { task, view } = await propose();
    const approved = await api('POST', `/confirmations/${view.confirmation.id}/approve`, { user: 'u1', body: { argsHash: view.confirmation.argsHash } });
    expect(approved.status).toBe(200);
    const done = await until(() => api('GET', `/tasks/${task.id}`, { user: 'u1' }), (r) => r.body.task.status === 'COMPLETED');
    expect(executed).toEqual(['u1:a,b']);
    expect(done.body.steps[0]).toMatchObject({ status: 'SUCCEEDED', verification: 're-read ok' });
    expect(done.body.confirmation).toBeNull();
    expect(done.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(done.text).not.toContain('untrusted_data');
    const replay = await api('POST', `/confirmations/${view.confirmation.id}/approve`, { user: 'u1', body: {} });
    expect(replay.status).toBe(409);
    expect(executed).toHaveLength(1);
  });

  it('refuses another user, an altered hash and malformed bodies', async () => {
    const { view } = await propose();
    const id = view.confirmation.id;
    expect((await api('POST', `/confirmations/${id}/approve`, { user: 'u2', body: {} })).status).toBe(404);
    expect((await api('POST', `/confirmations/${id}/reject`, { user: 'u2', body: {} })).status).toBe(404);
    const altered = await api('POST', `/confirmations/${id}/approve`, { user: 'u1', body: { argsHash: 'f'.repeat(64) } });
    expect(altered.status).toBe(409);
    expect(altered.body.code).toBe('CONFIRMATION_MISMATCH');
    expect((await api('POST', `/confirmations/${id}/approve`, { user: 'u1', body: { argsHash: 'nope' } })).status).toBe(400);
    expect(executed).toEqual([]);
  });

  it('records a rejection and lets the assistant respond without executing', async () => {
    const { task, view } = await propose();
    expect((await api('POST', `/confirmations/${view.confirmation.id}/reject`, { user: 'u1', body: {} })).status).toBe(200);
    const done = await until(() => api('GET', `/tasks/${task.id}`, { user: 'u1' }), (r) => r.body.task.status === 'COMPLETED');
    expect(executed).toEqual([]);
    expect(done.body.steps[0]).toMatchObject({ status: 'REJECTED' });
  });

  it('cancels a task that is waiting for confirmation', async () => {
    const { task, view } = await propose();
    const cancelled = await api('POST', `/tasks/${task.id}/cancel`, { user: 'u1', body: {} });
    expect(cancelled.body.task.status).toBe('CANCELLED');
    expect((await api('POST', `/confirmations/${view.confirmation.id}/approve`, { user: 'u1', body: {} })).status).toBe(409);
    expect(executed).toEqual([]);
  });

  it('allows only one active task per conversation and deletes everything with the conversation', async () => {
    const { conv, task } = await propose();
    expect((await api('POST', `/conversations/${conv.id}/messages`, { user: 'u1', body: { text: 'again' } })).status).toBe(409);
    expect((await api('DELETE', `/conversations/${conv.id}`, { user: 'u1' })).status).toBe(200);
    expect((await api('GET', `/tasks/${task.id}`, { user: 'u1' })).status).toBe(404);
    expect((await api('GET', `/conversations/${conv.id}`, { user: 'u1' })).status).toBe(404);
    expect(rt.store.data.messages).toHaveLength(0);
    expect(rt.store.data.confirmations.size).toBe(0);
  });
});

describe('direct (degraded-mode) tool runs', () => {
  it('runs read-only tools as the caller only', async () => {
    const res = await api('POST', '/tools/list_things/run', { user: 'u7', body: { args: {} } });
    expect(res.body).toMatchObject({ ok: true, data: { owner: 'u7' } });
  });

  it('refuses anything that is not read-only, unknown tools and invalid arguments', async () => {
    const trash = await api('POST', '/tools/trash_things/run', { user: 'u1', body: { args: { ids: ['a'] } } });
    expect(trash.status).toBe(403);
    expect(trash.body.code).toBe('TOOL_NOT_ALLOWED');
    expect(executed).toEqual([]);
    expect((await api('POST', '/tools/format_disk/run', { user: 'u1', body: {} })).status).toBe(404);
    expect((await api('POST', '/tools/list_things/run', { user: 'u1', body: { args: { extra: 1 } } })).status).toBe(200);
    expect((await api('POST', '/tools/trash_things/run', { user: 'u1', body: { args: { ids: [] } } })).status).toBe(400);
  });
});
