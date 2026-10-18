import { describe, expect, it, vi } from 'vitest';

interface Call {
  model: string;
  method: string;
  args: any;
}

const rec = vi.hoisted(() => ({ calls: [] as Array<{ model: string; method: string; args: any }> }));

vi.mock('../../config/prisma.js', () => {
  const defaults: Record<string, (args: any) => unknown> = {
    findMany: () => [],
    findFirst: () => null,
    findUnique: () => null,
    findFirstOrThrow: () => {
      throw Object.assign(new Error('not found'), { code: 'P2025' });
    },
    count: () => 0,
    groupBy: () => [],
    aggregate: () => ({ _sum: {}, _count: { _all: 0 } }),
    updateMany: () => ({ count: 0 }),
    deleteMany: () => ({ count: 0 }),
    create: (args) => ({ id: 'id', ...args.data }),
    update: (args) => ({ id: 'id', ...args.data }),
    upsert: (args) => ({
      id: 'p1',
      userId: 'u',
      mode: 'most_available',
      priorityAccountIds: [],
      roundRobinCursor: 0,
      fileTypeRules: null,
      minFileSizeBytes: null,
      maxFileSizeBytes: null,
      updatedAt: new Date(),
      ...(args.create ?? {}),
    }),
  };
  const modelProxy = (model: string) =>
    new Proxy({}, {
      get: (_t, method: string) => async (args: any) => {
        rec.calls.push({ model, method, args });
        const handler = defaults[method];
        if (!handler) throw new Error(`unmocked prisma.${model}.${method}`);
        return handler(args ?? {});
      },
    });
  return { prisma: new Proxy({}, { get: (_t, model: string) => modelProxy(model) }) };
});
vi.mock('../../utils/audit.js', () => ({ createAuditLog: async () => undefined }));
vi.mock('../../queues/queues.js', () => ({ enqueueJob: async () => 'job' }));
vi.mock('../../modules/s3/s3.service.js', () => ({ deleteS3Object: async () => undefined }));
vi.mock('../../providers/health.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../providers/health.js')>()),
  checkAccount: async () => ({ state: 'healthy', latencyMs: 1, message: null, checkedAt: new Date() }),
  refreshQuota: async () => undefined,
}));

import { loadAiConfig } from '../../modules/ai/config.js';
import { createDefaultRegistry } from '../../modules/ai/tools/index.js';
import { parseToolArgs, runTool } from '../../modules/ai/tools/registry.js';

const U = '00000000-0000-4000-8000-000000000001';
const config = loadAiConfig({ AI_PROVIDER: 'openai_compatible', AI_MODEL: 'm', AI_API_KEY: 'k' });
const tools = createDefaultRegistry();

/** Valid example arguments for every tool. A new tool without an entry fails the coverage test. */
const SAMPLE_ARGS: Record<string, unknown> = {
  list_storage_accounts: {},
  get_account_details: { accountId: U },
  compare_account_usage: {},
  find_accounts_needing_attention: {},
  test_account_connectivity: { accountId: U },
  refresh_account_quota: { accountId: U },
  set_account_routing: { accountId: U, enabled: false },
  disconnect_account: { accountId: U },
  search_files: { query: 'x' },
  get_file_details: { fileId: U },
  list_folders: {},
  find_duplicate_candidates: {},
  find_similar_names: {},
  plan_organize_by_year: {},
  create_folder: { name: 'F' },
  rename_file: { fileId: U, newName: 'n' },
  move_files: { fileIds: [U], folderId: null },
  trash_files: { fileIds: [U] },
  purge_files: { fileIds: [U] },
  start_migration: { sourceAccountId: U, targetAccountId: '00000000-0000-4000-8000-000000000002', mode: 'copy' },
  get_routing_policy: {},
  explain_routing: { sizeBytes: 100 },
  update_routing_policy: { mode: 'priority' },
  diagnose_uploads: { days: 7 },
  list_share_links: {},
  create_share_link: { fileId: U },
  revoke_share_links: { fileId: U },
  storage_usage_report: {},
  activity_report: { days: 7 },
  provider_health_summary: {},
  list_jobs: {},
  get_job_status: { jobId: U },
};

/** Models whose rows are only ever reached through ids that were already authorised. */
const KEYED_BY_AUTHORISED_IDS = new Set(['storageAccount', 'providerHealth']);

function isScoped(call: Call): boolean {
  if (KEYED_BY_AUTHORISED_IDS.has(call.model)) return true;
  const where = call.args?.where;
  if (!where) return call.method === 'create'; // creates carry userId in data (checked below)
  return where.userId === 'user-1' || (Array.isArray(where.AND) && where.AND.some((w: any) => w.userId === 'user-1'));
}

describe('tool authorisation scoping', () => {
  it('has sample arguments for every registered tool', () => {
    expect(Object.keys(SAMPLE_ARGS).sort()).toEqual(tools.all().map((t) => t.name).sort());
  });

  it('every database read/write issued by any tool is scoped to the requesting user', async () => {
    const offenders: string[] = [];
    for (const tool of tools.all()) {
      rec.calls.length = 0;
      const parsed = parseToolArgs(tool, SAMPLE_ARGS[tool.name]);
      expect(parsed.ok, `${tool.name} sample args`).toBe(true);
      const ctx = { userId: 'user-1', taskId: 't', config, now: () => new Date('2026-10-18T00:00:00Z') };
      if (tool.preview) await tool.preview((parsed as any).args, ctx).catch(() => undefined);
      await runTool(tool, (parsed as any).args, ctx);
      for (const call of rec.calls) {
        if (!isScoped(call)) offenders.push(`${tool.name}: prisma.${call.model}.${call.method} where=${JSON.stringify(call.args?.where)}`);
        if (call.method === 'create' && call.args?.data && 'userId' in call.args.data && call.args.data.userId !== 'user-1') {
          offenders.push(`${tool.name}: create for another user on ${call.model}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('acts as the requesting user even when the model supplies a different user id', async () => {
    const tool = tools.get('search_files')!;
    // The schema has no user field; extra keys are stripped before execution.
    const parsed = parseToolArgs(tool, { query: 'x', userId: 'someone-else' });
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify((parsed as any).args)).not.toContain('someone-else');
    rec.calls.length = 0;
    await runTool(tool, (parsed as any).args, { userId: 'user-1', taskId: 't', config, now: () => new Date() });
    expect(rec.calls.every((c) => c.args.where.userId === 'user-1')).toBe(true);
  });

  it('rejects malformed identifiers and oversized batches at validation time', () => {
    expect(parseToolArgs(tools.get('get_file_details')!, { fileId: '../../etc/passwd' }).ok).toBe(false);
    expect(parseToolArgs(tools.get('trash_files')!, { fileIds: [] }).ok).toBe(false);
    expect(parseToolArgs(tools.get('trash_files')!, { fileIds: Array(501).fill(U) }).ok).toBe(false);
    expect(parseToolArgs(tools.get('purge_files')!, { fileIds: Array(26).fill(U) }).ok).toBe(false);
    expect(parseToolArgs(tools.get('search_files')!, { limit: 1000 }).ok).toBe(false);
    expect(parseToolArgs(tools.get('search_files')!, undefined).ok).toBe(false);
  });
});

describe('tool output hygiene', () => {
  it('scrubs secret-shaped keys and strips control/bidi characters from any tool result', async () => {
    const { scrubValue } = await import('../../modules/ai/sanitize.js');
    const scrubbed = scrubValue({ name: 'a‮b', accessToken: 'tok', nested: { api_key: 'k', refresh_token: 'r', cookie: 'c', dlink: 'https://x', ok: 'fine', hasToken: true } }) as any;
    expect(scrubbed.name).toBe('a b');
    expect(scrubbed.accessToken).toBe('[redacted]');
    expect(scrubbed.nested).toMatchObject({ api_key: '[redacted]', refresh_token: '[redacted]', cookie: '[redacted]', dlink: '[redacted]', ok: 'fine', hasToken: true });
  });

  it('turns a tool that returns data violating its output contract into a failure', async () => {
    const { defineTool } = await import('../../modules/ai/tools/types.js');
    const { z } = await import('zod');
    const bad = defineTool({
      name: 'bad_tool', domain: 'system', description: 'x', input: z.object({}), output: z.object({ ok: z.literal(true) }), risk: 'low', timeoutMs: 1000, audit: false,
      execute: async () => ({ data: { ok: false }, summary: 'x' }),
    });
    expect(await runTool(bad, {}, { userId: 'u', taskId: 't', config, now: () => new Date() })).toMatchObject({ ok: false, code: 'INTERNAL' });
  });

  it('times out slow tools and never leaks internal error text', async () => {
    const { defineTool, ToolError } = await import('../../modules/ai/tools/types.js');
    const { z } = await import('zod');
    const slow = defineTool({
      name: 'slow_tool', domain: 'system', description: 'x', input: z.object({}), output: z.any(), risk: 'low', timeoutMs: 30, audit: false,
      execute: () => new Promise(() => undefined),
    });
    expect(await runTool(slow, {}, { userId: 'u', taskId: 't', config, now: () => new Date() })).toMatchObject({ ok: false, code: 'PROVIDER_ERROR' });
    const boom = defineTool({
      name: 'boom_tool', domain: 'system', description: 'x', input: z.object({}), output: z.any(), risk: 'low', timeoutMs: 1000, audit: false,
      execute: async () => {
        throw new Error('connect ECONNREFUSED postgres://user:secretpw@db:5432/x');
      },
    });
    const out = await runTool(boom, {}, { userId: 'u', taskId: 't', config, now: () => new Date() });
    expect(out).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect(JSON.stringify(out)).not.toContain('secretpw');
    void ToolError;
  });
});
