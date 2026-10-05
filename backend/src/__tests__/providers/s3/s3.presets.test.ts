/**
 * S3 presets, settings resolution, capability gating and SSRF rejection.
 * This file must NOT start the fake server: the environment stays clean so the
 * production SSRF gate behaves exactly as it does for a real request.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { catalog } from '../../../providers/catalog.js';
import { ProviderError } from '../../../providers/errors.js';
import { registry } from '../../../providers/registry.js';
import { DEFAULT_MULTIPART_PART_BYTES, DEFAULT_MULTIPART_THRESHOLD_BYTES, DEFAULT_PREFIX, resolveSettings } from '../../../providers/s3/client.js';
import { createS3Provider, registerS3Provider, s3Provider } from '../../../providers/s3/index.js';
import { S3_PRESET_IDS, getPreset, isS3PresetId, resolveS3Target } from '../../../providers/s3/presets.js';
import type { ProviderContext, ProviderCredentials } from '../../../providers/types.js';

function rawContext(input: { credentials?: Record<string, unknown>; config?: Record<string, unknown> } = {}): ProviderContext {
  const credentials: ProviderCredentials = Object.assign(
    { kind: 'access_key' as const, accessKeyId: 'AKIA_TEST', secretAccessKey: 'SECRET_TEST' },
    input.credentials ?? {},
  );
  return {
    credentials,
    account: {
      id: 'acc-1',
      userId: 'user-1',
      provider: 's3',
      providerAccountId: 'test-bucket:us-east-1',
      config: { bucket: 'test-bucket', ...(input.config ?? {}) },
    },
    logger: () => {},
  };
}

async function expectCode(run: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(ProviderError.is(caught), `expected ProviderError ${code}, got ${String(caught)}`).toBe(true);
  expect((caught as ProviderError).code).toBe(code);
}

beforeAll(() => {
  delete process.env.SSRF_ALLOWLIST;
  delete process.env.ALLOW_INSECURE_ENDPOINTS;
});

describe('s3 presets', () => {
  it('exposes exactly the six VIA_S3 preset ids', () => {
    expect([...S3_PRESET_IDS]).toEqual(['backblaze_b2', 'cloudflare_r2', 'idrive_e2', 'internxt', 'minio', 'wasabi']);
    for (const id of S3_PRESET_IDS) {
      expect(isS3PresetId(id)).toBe(true);
      const entry = catalog.get(id);
      expect(entry?.s3Preset, `${id} must carry a catalog s3Preset`).toBeDefined();
      expect(getPreset(id)).toEqual({ id, ...entry!.s3Preset! });
    }
    expect(isS3PresetId('dropbox')).toBe(false);
    expect(getPreset('dropbox')).toBeNull();
    expect(getPreset('aws')).toBeNull();
  });

  it('fills gaps from the preset and lets explicit values win', () => {
    expect(resolveS3Target({})).toEqual({ presetId: null, endpoint: null, region: 'us-east-1', forcePathStyle: false });

    const minio = resolveS3Target({ preset: 'minio' });
    expect(minio).toEqual({ presetId: 'minio', endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', forcePathStyle: true });

    const overridden = resolveS3Target({ preset: 'wasabi', endpoint: 'https://s3.eu-west-1.wasabisys.com/', region: 'eu-west-1', forcePathStyle: false });
    expect(overridden).toEqual({ presetId: 'wasabi', endpoint: 'https://s3.eu-west-1.wasabisys.com/', region: 'eu-west-1', forcePathStyle: false });

    const endpointOnly = resolveS3Target({ endpoint: 'https://s3.example.com' });
    expect(endpointOnly.forcePathStyle).toBe(true);
    expect(endpointOnly.region).toBe('us-east-1');

    const blankPreset = resolveS3Target({ preset: '   ', endpoint: null });
    expect(blankPreset.presetId).toBeNull();

    expect(() => resolveS3Target({ preset: 'not-a-preset' })).toThrow(ProviderError);
    try {
      resolveS3Target({ preset: 'not-a-preset' });
    } catch (error) {
      expect((error as ProviderError).code).toBe('ERR_INVALID_INPUT');
    }
  });

  it('merges presets through resolveSettings', () => {
    const preset = getPreset('minio')!;

    const fromConfig = resolveSettings(rawContext({ config: { preset: 'minio' } }));
    expect(fromConfig.endpoint).toBe(preset.endpoint);
    expect(fromConfig.region).toBe(preset.region);
    expect(fromConfig.forcePathStyle).toBe(true);
    expect(fromConfig.prefix).toBe(DEFAULT_PREFIX);
    expect(fromConfig.quotaBytes).toBeNull();
    expect(fromConfig.multipartThresholdBytes).toBe(DEFAULT_MULTIPART_THRESHOLD_BYTES);
    expect(fromConfig.multipartPartBytes).toBe(DEFAULT_MULTIPART_PART_BYTES);

    const altKey = resolveSettings(rawContext({ config: { s3Preset: 'wasabi' } }));
    expect(altKey.endpoint).toBe('https://s3.wasabisys.com');
    expect(altKey.forcePathStyle).toBe(false);

    const credentialsWin = resolveSettings(
      rawContext({ config: { preset: 'minio' }, credentials: { endpoint: 'https://s3.example.com', region: 'eu-central-1', forcePathStyle: false } }),
    );
    expect(credentialsWin.endpoint).toBe('https://s3.example.com');
    expect(credentialsWin.region).toBe('eu-central-1');
    expect(credentialsWin.forcePathStyle).toBe(false);

    const configWins = resolveSettings(
      rawContext({ config: { preset: 'minio', endpoint: 'https://s3.custom.example/', forcePathStyle: false, prefix: 'acme' } }),
    );
    expect(configWins.endpoint).toBe('https://s3.custom.example');
    expect(configWins.forcePathStyle).toBe(false);
    expect(configWins.prefix).toBe('acme');
  });

  it('parses quota and multipart tuning defensively', () => {
    expect(resolveSettings(rawContext({ config: { quotaBytes: '1024' } })).quotaBytes).toBe(1024n);
    expect(resolveSettings(rawContext({ config: { quotaBytes: -1 } })).quotaBytes).toBeNull();
    expect(resolveSettings(rawContext({ config: { quotaBytes: 'soon' } })).quotaBytes).toBeNull();
    expect(resolveSettings(rawContext({ config: { multipartThresholdBytes: 5 } })).multipartThresholdBytes).toBe(5);
    expect(resolveSettings(rawContext({ config: { multipartThresholdBytes: 0 } })).multipartThresholdBytes).toBe(1);
    expect(resolveSettings(rawContext({ config: { multipartPartBytes: 99 } })).multipartPartBytes).toBe(1024);
    expect(resolveSettings(rawContext({ config: { multipartPartBytes: Number.NaN } })).multipartPartBytes).toBe(DEFAULT_MULTIPART_PART_BYTES);
  });

  it('rejects unusable account configuration', () => {
    expectCode(Promise.resolve().then(() => resolveSettings(rawContext({ config: { bucket: undefined } }))), 'ERR_INVALID_INPUT');
    expectCode(Promise.resolve().then(() => resolveSettings(rawContext({ config: { bucket: 'bad/name' } }))), 'ERR_INVALID_INPUT');
    expectCode(Promise.resolve().then(() => resolveSettings(rawContext({ config: { bucket: '..' } }))), 'ERR_INVALID_INPUT');
    expectCode(Promise.resolve().then(() => resolveSettings(rawContext({ credentials: { secretAccessKey: '' } }))), 'ERR_INVALID_INPUT');
    expectCode(
      Promise.resolve().then(() => resolveSettings(rawContext({ credentials: { kind: 'oauth2', accessToken: 'x' } }))),
      'ERR_INVALID_INPUT',
    );
  });
});

describe('s3 capabilities and exports', () => {
  it('mirrors the catalog capability set by default', () => {
    const entry = catalog.get('s3');
    expect(entry).toBeTruthy();
    expect([...s3Provider.getCapabilities()].sort()).toEqual([...entry!.capabilities].sort());
    expect(s3Provider.id).toBe('s3');
    expect(s3Provider.authMode).toBe('access_key');
    expect(s3Provider.displayName).toBe('S3-compatible');
  });

  it('exports and registers the adapter', () => {
    expect(typeof registerS3Provider).toBe('function');
    const registered = registerS3Provider();
    expect(registered).toBe(s3Provider);
    expect(registry.get('s3')).toBe(s3Provider);
  });

  it('gates every capability before touching the network', async () => {
    const ctx = rawContext({ config: { endpoint: 'https://s3.example.com' } });
    const gated = createS3Provider({ capabilities: ['list'] });

    await expectCode(gated.authenticate(ctx), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(gated.getAccountInfo(ctx), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(gated.getQuota(ctx), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(
      gated.upload(ctx, {
        stream: Readable.from([Buffer.from('x')]),
        fileName: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: 1n,
        parentId: null,
      }),
      'ERR_CAPABILITY_UNSUPPORTED',
    );
    await expectCode(gated.download(ctx, { remoteId: 'x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(gated.createFolder(ctx, { name: 'd', parentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(gated.delete(ctx, { remoteId: 'x' }), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(gated.rename(ctx, { remoteId: 'x', newName: 'y.txt' }), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(gated.move(ctx, { remoteId: 'x', newParentId: null }), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(gated.copy(ctx, { remoteId: 'x', newParentId: null, newName: 'y.txt' }), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(gated.createShare(ctx, { remoteId: 'x', visibility: 'private' }), 'ERR_CAPABILITY_UNSUPPORTED');
    await expectCode(gated.healthCheck(ctx), 'ERR_CAPABILITY_UNSUPPORTED');

    const ranged = createS3Provider({ capabilities: ['download'] });
    await expectCode(ranged.download(ctx, { remoteId: 'x', range: { start: 0, end: 9 } }), 'ERR_CAPABILITY_UNSUPPORTED');

    await expectCode(s3Provider.revokeShare(ctx, { remoteId: 'x' }), 'ERR_CAPABILITY_UNSUPPORTED');
  });
});

describe('s3 endpoint SSRF gate', () => {
  async function blocked(endpoint: unknown): Promise<void> {
    const ctx = rawContext({ config: { endpoint } });
    await expectCode(s3Provider.list(ctx, { parentId: null, limit: 10 }), 'ERR_SSRF_BLOCKED');
  }

  it('rejects endpoints that are not plain https storage hosts', async () => {
    await blocked('http://objects.example.com');
    await blocked('https://example.com:22');
    await blocked('https://user:pass@example.com');
    await blocked('not a url');
    await blocked('https://metadata.google.internal');
    await blocked('https://example.com/#frag');
  });

  it('blocks loopback and link-local targets at every layer', async () => {
    await blocked('https://localhost:9000');
    await blocked('https://127.0.0.1:9000');
    await blocked('https://169.254.169.254');
    await blocked('https://10.0.0.5');
  });
});
