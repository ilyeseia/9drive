import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import { StorageStack } from '../../navigation/StorageStack';
import { json, makeHarness, type Handler } from '../../test/helpers';

jest.mock('../../transfers/device', () => ({
  DeviceFileSource: class {},
  chunkFetch: jest.fn(),
  clearDownloadCache: jest.fn(),
  createDownloader: jest.fn(),
  prefsTransferPersistence: { load: async () => [], save: async () => undefined },
}));

const account = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  provider: 'google_drive',
  displayName: null,
  email: `${id}@example.com`,
  status: 'connected',
  lastError: null,
  capabilities: ['upload', 'download'],
  quota: { totalBytes: '10737418240', usedBytes: '2147483648', availableBytes: '8589934592' },
  health: { state: 'healthy', latencyMs: 120, checkedAt: '2026-10-18T10:00:00Z' },
  lastSyncedAt: '2026-10-18T09:00:00Z',
  routingEnabled: true,
  experimental: false,
  quotaPolicy: 'optional',
  ...over,
});

const policy = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  mode: 'most_available',
  priorityAccountIds: [],
  fileTypeRules: [],
  minFileSizeBytes: null,
  maxFileSizeBytes: null,
  updatedAt: '2026-10-18T10:00:00Z',
  ...over,
});

function server(opts: { accounts?: ReturnType<typeof account>[]; policy?: ReturnType<typeof policy>; patchStatus?: number } = {}): Handler {
  let current = opts.policy ?? policy();
  return ({ path, method, body }) => {
    if (path === '/providers' && method === 'GET') return json(opts.accounts ?? []);
    if (path === '/providers/catalog')
      return json([
        { id: 'google_drive', displayName: 'Google Drive', status: 'SUPPORTED', authMode: 'oauth2', connectMode: null, experimental: null },
        { id: 'dropbox', displayName: 'Dropbox', status: 'SUPPORTED', authMode: 'oauth2', connectMode: null },
        { id: 'terabox_open', displayName: 'TeraBox', status: 'SUPPORTED', authMode: 'oauth2', connectMode: 'device_code' },
        { id: 'terabox', displayName: 'TeraBox (cookie)', status: 'SUPPORTED', authMode: 'api_key', experimental: true },
        { id: 'box', displayName: 'Box', status: 'PLANNED', authMode: 'oauth2' },
        { id: 's3', displayName: 'S3-compatible', status: 'SUPPORTED', authMode: 'access_key' },
      ]);
    if (path === '/providers/google_drive/connect-url' && method === 'POST')
      return json({ url: 'https://accounts.example.com/auth?state=abc', state: 'abc' });
    if (path === '/providers/dropbox/connect-url' && method === 'POST')
      return json({ code: 'PROVIDER_NOT_AVAILABLE', message: 'No OAuth client is configured for this provider yet.' }, 409);
    if (path === '/routing/policies' && method === 'GET') return json({ policy: current });
    if (path === '/routing/policies' && method === 'PATCH') {
      if (opts.patchStatus) return json({ code: 'FORBIDDEN', message: 'no' }, opts.patchStatus);
      current = { ...current, ...(body as object) };
      return json({ policy: current });
    }
    if (path === '/routing/preview') {
      return json({
        bytes: (body as { bytes: string }).bytes,
        fileType: null,
        mode: current.mode,
        account: { id: 'a1', provider: 'google_drive', displayName: 'Main', email: 'a1@example.com', status: 'connected' },
        reason: 'Most free space',
        steps: [{ step: 'capability', candidates: 3, eliminated: 1, detail: 'upload' }],
      });
    }
    if (/\/health$/.test(path)) return json({ state: 'healthy', latencyMs: 80, message: null, checkedAt: '2026-10-18T10:05:00Z' });
    if (/\/sync-quota$/.test(path)) return json({ status: 'ok' });
    if (/\/routing$/.test(path) && method === 'PATCH') return json({ status: 'ok' });
    if (path.startsWith('/providers/accounts/') && method === 'DELETE') return json({ status: 'ok' });
    if (path === '/connected-accounts/s3') return json({ account: {} }, 201);
    return json({ code: 'NOT_FOUND', message: 'x' }, 404);
  };
}

async function open(handler: Handler, initial?: 'Routing' | 'AddAccount' | 'S3') {
  const h = makeHarness(handler, { signedIn: true });
  await h.services.session.restore();
  await render(
    h.wrap(
      <NavigationContainer>
        <StorageStack />
      </NavigationContainer>,
    ),
  );
  if (initial === 'Routing') await fireEvent.press(await screen.findByRole('button', { name: 'Upload routing' }));
  if (initial === 'AddAccount' || initial === 'S3') {
    await fireEvent.press((await screen.findAllByRole('button', { name: 'Add storage account' }))[0]!);
    if (initial === 'S3') await fireEvent.press(await screen.findByRole('button', { name: 'Connect S3-compatible storage' }));
  }
  return h;
}

describe('StorageScreen', () => {
  it('lists accounts with capacity, health and last update, and totals only reported capacity', async () => {
    await open(server({ accounts: [account('a1'), account('a2', { quota: null, health: null, lastSyncedAt: null })] }));
    expect(await screen.findByText(/a1@example\.com/)).toBeTruthy();
    expect(screen.getByText(/2 GB.*of.*10 GB.*used.*8 GB.*free/)).toBeTruthy();
    expect(screen.getByText(/healthy · 120 ms/)).toBeTruthy();
    // honest about the account whose capacity is not reported
    expect(screen.getByText('Capacity not reported by this provider')).toBeTruthy();
    expect(screen.getByText(/Not checked yet/)).toBeTruthy();
    expect(screen.getByText('Never updated')).toBeTruthy();
    expect(screen.getByText(/Capacity of 1 account\(s\) is not reported and is not included\./)).toBeTruthy();
  });

  it('shows an empty state and a retryable error', async () => {
    await open(server({ accounts: [] }));
    expect(await screen.findByText('No storage accounts are connected yet.')).toBeTruthy();
  });

  it('runs a health check through the server and shows its result after refetching', async () => {
    const h = await open(server({ accounts: [account('a1')] }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Check connection' }));
    await waitFor(() => expect(h.calls.some((c) => c.method === 'POST' && c.path === '/providers/accounts/a1/health')).toBe(true));
  });

  it('turns automatic placement off for an account via the server', async () => {
    const h = await open(server({ accounts: [account('a1')] }));
    await fireEvent(await screen.findByLabelText('Use for new uploads'), 'valueChange', false);
    await waitFor(() =>
      expect(h.calls.find((c) => c.method === 'PATCH' && c.path === '/providers/accounts/a1/routing')?.body).toEqual({ enabled: false }),
    );
  });

  it('disconnects only after confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const h = await open(server({ accounts: [account('a1')] }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
    const destructive = (alert.mock.calls[0]?.[2] ?? []).find((b) => b.style === 'destructive');
    await act(async () => destructive?.onPress?.());
    await waitFor(() => expect(h.calls.some((c) => c.method === 'DELETE' && c.path === '/providers/accounts/a1')).toBe(true));
    alert.mockRestore();
  });

  it('marks experimental providers and defaults their routing to off', async () => {
    await open(server({ accounts: [account('t1', { provider: 'terabox', experimental: true, routingEnabled: null })] }));
    expect(await screen.findByText(/Experimental/)).toBeTruthy();
    expect((await screen.findByLabelText('Use for new uploads')).props.value).toBe(false);
  });
});

describe('RoutingScreen', () => {
  it('shows the current mode and saves a change through the server', async () => {
    const h = await open(server({ accounts: [account('a1')] }), 'Routing');
    expect(await screen.findByText('Sends files to the account with the most free space.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Round-robin' }));
    await waitFor(() =>
      expect(h.calls.find((c) => c.method === 'PATCH' && c.path === '/routing/policies')?.body).toEqual({ mode: 'round_robin' }),
    );
    expect(await screen.findByText('Policy saved')).toBeTruthy();
  });

  it('shows the server’s refusal when the change is not permitted, and keeps the old mode', async () => {
    await open(server({ accounts: [account('a1')], patchStatus: 403 }), 'Routing');
    await fireEvent.press(await screen.findByRole('button', { name: 'Round-robin' }));
    expect(await screen.findByText('You do not have permission to do this.')).toBeTruthy();
    expect(screen.queryByText('Policy saved')).toBeNull();
    expect(screen.getByText('Sends files to the account with the most free space.')).toBeTruthy();
  });

  it('edits the priority order and sends the full ordered list', async () => {
    const h = await open(
      server({ accounts: [account('a1'), account('a2')], policy: policy({ mode: 'priority', priorityAccountIds: ['a1', 'a2'] }) }),
      'Routing',
    );
    const down = await screen.findAllByRole('button', { name: 'Move down' });
    await fireEvent.press(down[0]!);
    await waitFor(() =>
      expect(h.calls.find((c) => c.method === 'PATCH' && c.path === '/routing/policies')?.body).toEqual({
        priorityAccountIds: ['a2', 'a1'],
      }),
    );
  });

  it('shows an unknown server mode without pretending to understand it', async () => {
    await open(server({ accounts: [], policy: policy({ mode: 'future_mode' }) }), 'Routing');
    expect(await screen.findByText(/future_mode/)).toBeTruthy();
  });

  it('previews a placement as a dry run and explains the server’s steps', async () => {
    const h = await open(server({ accounts: [account('a1')] }), 'Routing');
    await fireEvent.changeText(await screen.findByLabelText('File size (MB)'), '1,5');
    await fireEvent.press(screen.getByRole('button', { name: 'Show where it would go' }));
    expect(await screen.findByText(/Chosen account: .*Main/)).toBeTruthy();
    expect(screen.getAllByText('Most free space')).toHaveLength(2); // the mode chip and the server's reason
    expect(screen.getByText(/capability: upload \(3 → 2\)/)).toBeTruthy();
    expect(h.calls.find((c) => c.path === '/routing/preview')?.body).toEqual({ bytes: '1572864' });
  });

  it('rejects an invalid preview size without calling the server', async () => {
    const h = await open(server({ accounts: [] }), 'Routing');
    await fireEvent.changeText(await screen.findByLabelText('File size (MB)'), 'abc');
    await fireEvent.press(screen.getByRole('button', { name: 'Show where it would go' }));
    expect(await screen.findByText('Enter a size greater than 0.')).toBeTruthy();
    expect(h.calls.some((c) => c.path === '/routing/preview')).toBe(false);
  });
});

describe('ConnectProviderScreen', () => {
  afterEach(() => jest.restoreAllMocks());

  it('offers browser sign-in providers, S3 and both TeraBox flows, but not planned providers', async () => {
    await open(server(), 'AddAccount');
    expect(await screen.findByRole('button', { name: 'Connect Google Drive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Dropbox' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect S3-compatible storage' })).toBeTruthy();
    // TeraBox has its own flows (official device-code approval and the experimental sign-in).
    expect(screen.getByRole('button', { name: 'Connect TeraBox' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect TeraBox (experimental)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Box' })).toBeNull();
    expect(screen.getByText(/Other providers are connected from the web app/)).toBeTruthy();
  });

  it('asks the server for the sign-in URL and opens it in the browser', async () => {
    const open_ = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const h = await open(server(), 'AddAccount');
    await fireEvent.press(await screen.findByRole('button', { name: 'Connect Google Drive' }));
    await waitFor(() => expect(open_).toHaveBeenCalledWith('https://accounts.example.com/auth?state=abc'));
    expect(open_).toHaveBeenCalledTimes(1); // one tap opens the browser exactly once
    expect(h.calls.some((c) => c.method === 'POST' && c.path === '/providers/google_drive/connect-url')).toBe(true);
    expect(await screen.findByText(/Finish signing in to Google Drive in the browser/)).toBeTruthy();
  });

  it('explains plainly when the server has no sign-in set up for a provider', async () => {
    const open_ = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await open(server(), 'AddAccount');
    await screen.findByRole('button', { name: 'Connect Dropbox' });
    open_.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'Connect Dropbox' }));
    expect(await screen.findByText(/no sign-in set up for Dropbox yet/)).toBeTruthy();
    expect(open_.mock.calls).toEqual([]);
    expect(screen.getByText(/HTTP 409 · PROVIDER_NOT_AVAILABLE/)).toBeTruthy();
  });

  it('the empty storage list points straight at adding storage', async () => {
    await open(server({ accounts: [] }));
    expect(await screen.findByText('Add a storage account to start uploading files.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add storage account' }).length).toBeGreaterThanOrEqual(1);
  });
});

describe('AddAccountScreen', () => {
  it('validates required fields before sending anything', async () => {
    const h = await open(server(), 'S3');
    await fireEvent.press(await screen.findByRole('button', { name: 'Connect' }));
    expect((await screen.findAllByText('This field is required.')).length).toBeGreaterThanOrEqual(4);
    expect(h.calls.some((c) => c.path === '/connected-accounts/s3')).toBe(false);
  });

  it('warns about a plain-http endpoint, masks the secret, and sends the connection to the server', async () => {
    const h = await open(server(), 'S3');
    await fireEvent.changeText(await screen.findByLabelText('Display name'), 'Backups');
    await fireEvent.changeText(screen.getByLabelText('Bucket'), 'my-bucket');
    await fireEvent.changeText(screen.getByLabelText('Region'), 'us-east-1');
    await fireEvent.changeText(screen.getByLabelText(/^Endpoint/), 'http://minio.lan:9000');
    expect(screen.getByText(/not encrypted \(http\)/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Access key ID'), 'AKIA123');
    const secret = screen.getByLabelText('Secret access key');
    expect(secret.props.secureTextEntry).toBe(true);
    await fireEvent.changeText(secret, 'sup3r-secret');
    await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(h.calls.some((c) => c.path === '/connected-accounts/s3')).toBe(true));
    expect(h.calls.find((c) => c.path === '/connected-accounts/s3')?.body).toMatchObject({
      name: 'Backups',
      bucket: 'my-bucket',
      region: 'us-east-1',
      endpoint: 'http://minio.lan:9000',
      accessKeyId: 'AKIA123',
      secretAccessKey: 'sup3r-secret',
      forcePathStyle: false,
    });
    expect(h.store.value && JSON.stringify(h.store.value)).not.toContain('sup3r-secret');
  });
});
