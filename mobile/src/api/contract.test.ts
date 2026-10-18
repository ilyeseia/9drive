import { ApiClient } from './client';
import { aiApi } from './endpoints/ai';
import { authApi } from './endpoints/auth';
import { filesApi, foldersApi } from './endpoints/files';
import { providersApi } from './endpoints/providers';
import { sharingApi } from './endpoints/sharing';

/**
 * Network data is untrusted. For every read endpoint: a malformed, truncated or hostile body must become a typed
 * `invalid_response` error — never a crash, never data flowing into the UI.
 */
const GARBAGE: unknown[] = [null, 'text', 42, [1], {}, { files: 'x' }, { files: [{ id: 1 }] }, { __proto__: { polluted: true } }];

function clientReturning(body: unknown, status = 200) {
  const fetchImpl = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
  return new ApiClient({
    baseUrl: 'https://api.test',
    fetchImpl,
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    sleep: async () => undefined,
  });
}

const endpoints: [string, (c: ApiClient) => Promise<unknown>][] = [
  ['auth.login', (c) => authApi.login(c, 'a@b.co', 'x')],
  ['auth.me', (c) => authApi.me(c)],
  ['files.list', (c) => filesApi.list(c, {})],
  ['files.get', (c) => filesApi.get(c, 'f1')],
  ['folders.list', (c) => foldersApi.list(c, null)],
  ['providers.accounts', (c) => providersApi.accounts(c)],
  ['providers.catalog', (c) => providersApi.catalog(c)],
  ['providers.routingPolicy', (c) => providersApi.routingPolicy(c)],
  ['providers.preview', (c) => providersApi.previewRouting(c, { bytes: 10 })],
  ['sharing.list', (c) => sharingApi.list(c)],
  ['sharing.create', (c) => sharingApi.create(c, 'f1')],
  ['ai.status', (c) => aiApi.status(c)],
  ['ai.task', (c) => aiApi.task(c, 't1', 0)],
  ['ai.conversations', (c) => aiApi.conversations(c)],
];

describe('malformed responses never reach the UI', () => {
  for (const [name, call] of endpoints) {
    it(`${name} rejects garbage bodies with invalid_response`, async () => {
      for (const garbage of GARBAGE) {
        await expect(call(clientReturning(garbage))).rejects.toMatchObject({ kind: 'invalid_response' });
      }
    });
  }

  it('HTML or truncated JSON from a proxy is an error, not a crash', async () => {
    for (const body of ['<html>502</html>', '{"files":[{"id":"x"', '']) {
      await expect(filesApi.list(clientReturning(body), {})).rejects.toMatchObject({ kind: 'invalid_response' });
    }
  });

  it('rejects out-of-contract values inside otherwise valid shapes', async () => {
    const badFile = { id: 'f', name: 'n', mimeType: 'x', sizeBytes: '-5', provider: 'p', createdAt: '2026-10-18T10:00:00Z' };
    await expect(filesApi.list(clientReturning({ files: [badFile] }), {})).rejects.toMatchObject({ kind: 'invalid_response' });
    const badDate = { ...badFile, sizeBytes: '5', createdAt: 'not-a-date' };
    await expect(filesApi.list(clientReturning({ files: [badDate] }), {})).rejects.toMatchObject({ kind: 'invalid_response' });
    const badHash = {
      task: { id: 't', conversationId: 'c', status: 'COMPLETED', stepCount: 0, toolCallCount: 0, error: null },
      steps: [],
      messages: [],
      confirmation: {
        id: 'c',
        status: 'PENDING',
        tool: 't',
        risk: 'high',
        summary: 's',
        preview: null,
        argsHash: 'short',
        expiresAt: '2026-10-18T10:00:00Z',
      },
    };
    await expect(aiApi.task(clientReturning(badHash), 't', 0)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('does not let a hostile body pollute Object.prototype', async () => {
    const polluted = '{"__proto__":{"polluted":true},"files":[]}';
    await filesApi.list(clientReturning(polluted), {}).catch(() => undefined);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('server error bodies are never surfaced verbatim (messages come from the app catalogue)', async () => {
    await expect(
      filesApi.list(clientReturning({ code: 'X', message: '<script>alert(1)</script> /srv/app/secret.ts:12' }, 500), {}),
    ).rejects.toMatchObject({ kind: 'server' });
  });
});
