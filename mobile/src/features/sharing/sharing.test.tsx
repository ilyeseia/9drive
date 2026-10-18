import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';
import { isTrustedShareUrl } from '../../api/endpoints/sharing';
import { FilesStack } from '../../navigation/FilesStack';
import { json, makeHarness, type Handler } from '../../test/helpers';

jest.mock('../../transfers/device', () => ({
  DeviceFileSource: class {},
  chunkFetch: jest.fn(),
  clearDownloadCache: jest.fn(),
  createDownloader: jest.fn(),
  prefsTransferPersistence: { load: async () => [], save: async () => undefined },
  pickDocuments: jest.fn(),
  pickPhotos: jest.fn(),
  takePhoto: jest.fn(),
  shareLocalFile: jest.fn(async () => true),
}));
const mockSetString = jest.fn(async () => true);
jest.mock('expo-clipboard', () => ({
  setStringAsync: (...a: unknown[]) => mockSetString(...(a as [])),
  getStringAsync: jest.fn(async () => ''),
}));

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const FILE = {
  id: 'f1',
  name: 'Report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: '1048576',
  provider: 'google_drive',
  createdAt: '2026-10-18T10:00:00Z',
  folderId: null,
  connectedAccount: { id: 'a1', email: 'me@example.com', provider: 'google_drive' },
  folder: null,
};

function server(opts: { shares?: object[]; createUrl?: string } = {}): Handler {
  let shares = opts.shares ?? [];
  return ({ path, method }) => {
    if (path === '/files' && method === 'GET') return json({ files: [FILE] });
    if (path === '/folders') return json({ folders: [] });
    if (path === '/files/f1' && method === 'GET') return json({ file: FILE });
    if (path === '/files/shared-links') return json({ shares });
    if (path === '/files/f1/share' && method === 'POST') {
      shares = [{ id: 's1', createdAt: '2026-10-18T10:00:00Z', expiresAt: '2026-11-17T10:00:00Z', file: FILE }];
      return json({ url: opts.createUrl ?? `https://drive.example.com/public/files/${TOKEN}`, shareId: 's1' }, 201);
    }
    if (path === '/files/f1/share' && method === 'DELETE') {
      shares = [];
      return json({ status: 'ok' });
    }
    return json({ code: 'NOT_FOUND', message: 'x' }, 404);
  };
}

async function openDetails(handler: Handler) {
  const h = makeHarness(handler, { signedIn: true });
  await h.services.session.restore();
  await render(
    h.wrap(
      <NavigationContainer>
        <FilesStack />
      </NavigationContainer>,
    ),
  );
  await fireEvent.press(await screen.findByRole('button', { name: /Report\.pdf/ }));
  await screen.findByText('Share link');
  return h;
}

const confirmLastAlert = async (alert: jest.SpyInstance, label: string) => {
  const button = (alert.mock.calls.at(-1)?.[2] ?? []).find((b: { text?: string }) => b.text === label);
  await act(async () => button?.onPress?.());
};

describe('isTrustedShareUrl', () => {
  it('accepts a public-page link and rejects anything else', () => {
    const api = 'https://api.example.com';
    expect(isTrustedShareUrl(`https://drive.example.com/public/files/${TOKEN}`, api)).toBe(true);
    expect(isTrustedShareUrl('javascript:alert(1)', api)).toBe(false);
    expect(isTrustedShareUrl(`https://user:pw@drive.example.com/public/files/${TOKEN}`, api)).toBe(false);
    expect(isTrustedShareUrl('https://drive.example.com/other/path', api)).toBe(false);
    expect(isTrustedShareUrl('https://drive.example.com/public/files/short', api)).toBe(false);
    expect(isTrustedShareUrl(`http://drive.example.com/public/files/${TOKEN}`, api)).toBe(false); // no downgrade to http
    expect(isTrustedShareUrl(`http://10.0.2.2:5173/public/files/${TOKEN}`, 'http://10.0.2.2:4000')).toBe(true); // debug builds
    expect(isTrustedShareUrl('not a url', api)).toBe(false);
  });
});

describe('SharePanel', () => {
  afterEach(() => jest.restoreAllMocks());

  it('warns that the file becomes public and creates nothing until confirmed', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const h = await openDetails(server());
    await fireEvent.press(screen.getByRole('button', { name: 'Create public link' }));
    expect(alert.mock.calls[0]?.[0]).toBe('Make this file public?');
    expect(String(alert.mock.calls[0]?.[1])).toMatch(/Anyone who has the link can view and download/);
    expect(h.calls.some((c) => c.method === 'POST' && c.path === '/files/f1/share')).toBe(false);
    await confirmLastAlert(alert, 'Cancel');
    expect(h.calls.some((c) => c.path === '/files/f1/share')).toBe(false);
  });

  it('after confirming, shows the link once with its real expiry, and copies/sends it', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const send = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const h = await openDetails(server());
    await fireEvent.press(screen.getByRole('button', { name: 'Create public link' }));
    await confirmLastAlert(alert, 'Create public link');
    expect(await screen.findByText('Link created')).toBeTruthy();
    expect(screen.getByText(new RegExp(TOKEN))).toBeTruthy();
    expect(await screen.findByText(/Expires/)).toBeTruthy();
    expect(screen.getByText(/shown only now/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(mockSetString).toHaveBeenCalledWith(`https://drive.example.com/public/files/${TOKEN}`));
    expect(await screen.findByText(/removed from the clipboard after about 90 seconds/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Send link…' }));
    expect(send).toHaveBeenCalledWith({ message: `https://drive.example.com/public/files/${TOKEN}` });
    expect(h.calls.filter((c) => c.method === 'POST' && c.path === '/files/f1/share')).toHaveLength(1);
  });

  it('refuses to display a link it does not trust', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await openDetails(server({ createUrl: 'https://evil.example.net/phish' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create public link' }));
    await confirmLastAlert(alert, 'Create public link');
    expect(await screen.findByText(/does not trust/)).toBeTruthy();
    expect(screen.queryByText(/evil\.example\.net/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  it('revokes every link only after confirmation, then reports it', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const h = await openDetails(
      server({ shares: [{ id: 's1', createdAt: '2026-10-18T10:00:00Z', expiresAt: '2026-11-17T10:00:00Z', file: FILE }] }),
    );
    expect(await screen.findByText(/1 active public link/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revoke all links' }));
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await confirmLastAlert(alert, 'Revoke all links');
    await waitFor(() => expect(h.calls.some((c) => c.method === 'DELETE' && c.path === '/files/f1/share')).toBe(true));
    expect(await screen.findByText('All links revoked')).toBeTruthy();
  });
});
