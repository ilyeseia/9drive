import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAiOverride, getAiConfig, type ConfigOverride } from '../../modules/ai/config.js';
import { createMemoryProfileStore, createProfileSchema, createProfileService, ProfileError, type ProbeResult } from '../../modules/ai/profiles.js';

const encrypt = (v: string) => `enc(${Buffer.from(v).toString('base64')})`;
const decrypt = (v: string) => Buffer.from(v.slice(4, -1), 'base64').toString();

function setup(probeResult: ProbeResult = { ok: true, latencyMs: 12, code: null, model: 'auto' }) {
  const store = createMemoryProfileStore();
  const applied: Array<ConfigOverride | null> = [];
  const probe = vi.fn(async (_o: ConfigOverride) => probeResult);
  const service = createProfileService({ store, encrypt, decrypt, apply: (o) => void applied.push(o), probe });
  return { store, applied, probe, service };
}

const input = (over: Record<string, unknown> = {}) =>
  createProfileSchema.parse({ name: 'Gateway', provider: 'openai_compatible', model: 'auto', baseUrl: 'https://llm.example.net/v1/', apiKey: 'sk-secret-123', ...over });

describe('model profiles', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('stores the key encrypted and never exposes it', async () => {
    const dto = await ctx.service.create(input());
    expect(dto).toMatchObject({ name: 'Gateway', hasKey: true, isActive: false, baseUrl: 'https://llm.example.net/v1' });
    expect(JSON.stringify(dto)).not.toContain('sk-secret-123');
    const row = (await ctx.store.list())[0];
    expect(row.apiKeyEnc).toBe(encrypt('sk-secret-123'));
    expect(JSON.stringify(await ctx.service.list())).not.toContain('sk-secret-123');
  });

  it('rejects settings the assistant could not run with', async () => {
    await expect(ctx.service.create(input({ provider: 'anthropic', apiKey: undefined }))).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    await expect(ctx.service.create(input({ baseUrl: undefined, apiKey: undefined }))).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    await expect(ctx.service.create(input({ baseUrl: 'ftp://x/v1' }))).rejects.toBeInstanceOf(ProfileError);
    await expect(ctx.service.create(input({ baseUrl: 'https://x.example/v1?token=abc' }))).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    await expect(ctx.service.create(input({ baseUrl: 'https://user:pw@x.example/v1' }))).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    // a self-hosted OpenAI-compatible server may omit the key
    await expect(ctx.service.create(input({ name: 'Local', apiKey: undefined, baseUrl: 'http://localhost:11434/v1' }))).resolves.toMatchObject({ hasKey: false });
  });

  it('rejects duplicate names case-insensitively', async () => {
    await ctx.service.create(input());
    await expect(ctx.service.create(input({ name: 'gateway' }))).rejects.toMatchObject({ code: 'NAME_TAKEN', status: 409 });
  });

  it('activates exactly one profile and applies it with the decrypted key', async () => {
    const a = await ctx.service.create(input({ name: 'A' }));
    const b = await ctx.service.create(input({ name: 'B', model: 'other', apiKey: 'sk-b' }));
    await ctx.service.activate(a.id);
    await ctx.service.activate(b.id);
    const { profiles, activeId } = await ctx.service.list();
    expect(activeId).toBe(b.id);
    expect(profiles.filter((p) => p.isActive).map((p) => p.name)).toEqual(['B']);
    expect(ctx.applied.at(-1)).toEqual({ provider: 'openai_compatible', model: 'other', baseUrl: 'https://llm.example.net/v1', apiKey: 'sk-b' });
    await expect(ctx.service.activate('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 });
  });

  it('keeps the stored key when updating without one, replaces it otherwise, and re-applies when active', async () => {
    const dto = await ctx.service.create(input());
    await ctx.service.activate(dto.id);
    ctx.applied.length = 0;
    await ctx.service.update(dto.id, { model: 'auto-2' });
    expect(ctx.applied.at(-1)).toMatchObject({ model: 'auto-2', apiKey: 'sk-secret-123' });
    await ctx.service.update(dto.id, { apiKey: 'sk-new' });
    expect(ctx.applied.at(-1)?.apiKey).toBe('sk-new');
    expect((await ctx.store.get(dto.id))?.apiKeyEnc).toBe(encrypt('sk-new'));
    // clearing the key and the endpoint would leave nothing runnable
    await expect(ctx.service.update(dto.id, { apiKey: '', baseUrl: null })).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
  });

  it('clears the last test result only when the connection changes', async () => {
    const dto = await ctx.service.create(input());
    expect((await ctx.service.test(dto.id)).profile.lastTest).toMatchObject({ ok: true });
    expect((await ctx.service.update(dto.id, { name: 'Renamed' })).lastTest).not.toBeNull();
    expect((await ctx.service.update(dto.id, { model: 'x' })).lastTest).toBeNull();
  });

  it('falls back to the environment when the active profile is deleted or deactivated', async () => {
    const dto = await ctx.service.create(input());
    await ctx.service.activate(dto.id);
    await ctx.service.remove(dto.id);
    expect(ctx.applied.at(-1)).toBeNull();
    const other = await ctx.service.create(input({ name: 'Other' }));
    await ctx.service.activate(other.id);
    await ctx.service.useEnvironment();
    expect(ctx.applied.at(-1)).toBeNull();
    expect((await ctx.service.list()).activeId).toBeNull();
    // deleting an inactive profile does not touch the live config
    ctx.applied.length = 0;
    await ctx.service.remove(other.id);
    expect(ctx.applied).toEqual([]);
  });

  it('tests a stored model with its decrypted key and records the outcome', async () => {
    const failing = setup({ ok: false, latencyMs: 30, code: 'MODEL_AUTH', model: null });
    const dto = await failing.service.create(input());
    const result = await failing.service.test(dto.id);
    expect(failing.probe).toHaveBeenCalledWith({ provider: 'openai_compatible', model: 'auto', baseUrl: 'https://llm.example.net/v1', apiKey: 'sk-secret-123' });
    expect(result).toMatchObject({ ok: false, code: 'MODEL_AUTH' });
    expect(result.profile.lastTest).toMatchObject({ ok: false, code: 'MODEL_AUTH', latencyMs: 30 });
  });

  it('tests unsaved values without storing them, reusing the stored key when editing', async () => {
    await ctx.service.testDraft(input({ apiKey: 'sk-draft' }));
    expect(ctx.probe).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'sk-draft' }));
    expect(await ctx.store.list()).toEqual([]);
    const dto = await ctx.service.create(input());
    await ctx.service.testDraft(input({ apiKey: undefined, model: 'changed' }), dto.id);
    expect(ctx.probe).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'changed', apiKey: 'sk-secret-123' }));
    await expect(ctx.service.testDraft(input({ provider: 'anthropic', apiKey: undefined }))).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
  });

  it('re-applies the active profile at boot and ignores an undecryptable one', async () => {
    const dto = await ctx.service.create(input());
    await ctx.service.activate(dto.id);
    ctx.applied.length = 0;
    expect((await ctx.service.applyActive())?.name).toBe('Gateway');
    expect(ctx.applied).toHaveLength(1);

    const broken = createProfileService({
      store: ctx.store,
      encrypt,
      decrypt: () => {
        throw new Error('bad key');
      },
      apply: (o) => void ctx.applied.push(o),
    });
    ctx.applied.length = 0;
    expect(await broken.applyActive()).toBeNull();
    expect(ctx.applied).toEqual([]);
  });
});

describe('applyAiOverride', () => {
  it('mutates the shared config in place and can return to the environment', () => {
    const shared = getAiConfig();
    const env = { AI_PROVIDER: 'anthropic', AI_MODEL: 'env-model', AI_API_KEY: 'env-key', AI_MAX_STEPS: '5' };
    applyAiOverride(null, env);
    expect(shared).toMatchObject({ enabled: true, provider: 'anthropic', model: 'env-model', maxSteps: 5 });
    applyAiOverride({ provider: 'openai_compatible', model: 'auto', baseUrl: 'https://llm.example.net/v1', apiKey: 'k' }, env);
    expect(getAiConfig()).toBe(shared);
    expect(shared).toMatchObject({ enabled: true, provider: 'openai_compatible', model: 'auto', baseUrl: 'https://llm.example.net/v1', apiKey: 'k', maxSteps: 5 });
    applyAiOverride(null, env);
    expect(shared).toMatchObject({ provider: 'anthropic', model: 'env-model', baseUrl: null });
  });
});
