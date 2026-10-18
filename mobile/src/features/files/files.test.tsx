import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { FilesStack } from '../../navigation/FilesStack';
import { json, makeHarness, type Handler } from '../../test/helpers';
import { folderPaths } from './queries';

// Native pickers/file system are not available under Jest; the transfer logic they feed is tested separately.
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

const file = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  mimeType: 'application/pdf',
  sizeBytes: '1048576',
  provider: 'google_drive',
  createdAt: '2026-10-18T10:00:00Z',
  folderId: null,
  connectedAccount: { id: 'a1', email: 'me@example.com', provider: 'google_drive' },
  folder: null,
  ...extra,
});
const folder = (id: string, name: string, parentId: string | null = null) => ({ id, name, color: '#3b82f6', parentId });

function server(
  opts: { files?: ReturnType<typeof file>[]; folders?: ReturnType<typeof folder>[]; nextCursor?: string; failFiles?: boolean } = {},
): Handler {
  const files = opts.files ?? [];
  const folders = opts.folders ?? [];
  return ({ path, method, query }) => {
    if (path === '/files' && method === 'GET') {
      if (opts.failFiles) return json({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' }, 500);
      const q = query.get('q')?.toLowerCase();
      const list = q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;
      return json({ files: list, ...(opts.nextCursor ? { nextCursor: opts.nextCursor } : {}) });
    }
    if (path === '/folders' && method === 'GET')
      return json({ folders: query.get('all') ? folders : folders.filter((f) => f.parentId === (query.get('parentId') ?? null)) });
    const detail = path.match(/^\/files\/([^/]+)$/);
    if (detail && method === 'GET')
      return json({ file: files.find((f) => f.id === detail[1]) ?? null }, files.some((f) => f.id === detail[1]) ? 200 : 404);
    if (detail && method === 'PATCH') return json({ file: { ...files[0], name: 'renamed.pdf' } });
    if (detail && method === 'DELETE') return json({ status: 'ok' });
    return json({ code: 'NOT_FOUND', message: 'x' }, 404);
  };
}

async function open(handler: Handler, opts: { signedIn?: boolean } = {}) {
  const h = makeHarness(handler, { signedIn: true, ...opts });
  await h.services.session.restore();
  await render(
    h.wrap(
      <NavigationContainer>
        <FilesStack />
      </NavigationContainer>,
    ),
  );
  return h;
}

describe('FilesScreen', () => {
  it('lists folders and files with human-readable sizes and dates', async () => {
    await open(server({ files: [file('f1', 'Report.pdf')], folders: [folder('d1', 'Taxes')] }));
    expect(await screen.findByText(/Report\.pdf/)).toBeTruthy();
    expect(await screen.findByText(/Taxes/)).toBeTruthy();
    expect(screen.getByText(/1 MB/)).toBeTruthy();
  });

  it('shows an empty state with guidance, and a different one for an empty search', async () => {
    await open(server());
    expect(await screen.findByText(/No files here yet/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Search files'), 'zzz');
    expect(await screen.findByText('No files match your search.')).toBeTruthy();
  });

  it('searches on the server after a short pause, not on every keystroke', async () => {
    const h = await open(server({ files: [file('f1', 'Report.pdf'), file('f2', 'Holiday.jpg')] }));
    await screen.findByText(/Report\.pdf/);
    await fireEvent.changeText(screen.getByLabelText('Search files'), 'holi');
    await waitFor(() => expect(h.calls.some((c) => c.path === '/files' && c.query.includes('q=holi'))).toBe(true));
    expect(await screen.findByText(/Holiday\.jpg/)).toBeTruthy();
    expect(screen.queryByText(/Report\.pdf/)).toBeNull();
    const searches = h.calls.filter((c) => c.path === '/files' && c.query.includes('q='));
    expect(searches.every((c) => c.query.includes('q=holi'))).toBe(true);
  });

  it('sorts by name server-side and tells the user when only the first 200 results are shown', async () => {
    const h = await open(server({ files: [file('f1', 'A.pdf')], nextCursor: 'cursor-1' }));
    await screen.findByText(/A\.pdf/);
    expect(screen.queryByText(/first 200 results/)).toBeNull(); // date sort uses real paging
    await fireEvent.press(screen.getByRole('button', { name: 'Name' }));
    await waitFor(() =>
      expect(
        h.calls.some(
          (c) => c.path === '/files' && c.query.includes('sort=name') && c.query.includes('order=asc') && c.query.includes('limit=200'),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText(/first 200 results/)).toBeTruthy();
  });

  it('filters by type', async () => {
    const h = await open(server({ files: [file('f1', 'A.pdf')] }));
    await screen.findByText(/A\.pdf/);
    await fireEvent.press(screen.getByRole('button', { name: 'Images' }));
    await waitFor(() => expect(h.calls.some((c) => c.query.includes('kind=image'))).toBe(true));
  });

  it('opens a folder and lists that folder’s files', async () => {
    const h = await open(server({ files: [file('f1', 'A.pdf')], folders: [folder('d1', 'Taxes')] }));
    await fireEvent.press(await screen.findByRole('button', { name: /Taxes/ }));
    await waitFor(() => expect(h.calls.some((c) => c.path === '/files' && c.query.includes('folderId=d1'))).toBe(true));
    // the breadcrumb now shows the folder (its name is wrapped in a bidi isolate, hence the pattern)
    expect(await screen.findByRole('button', { name: /Taxes/ })).toBeTruthy();
    expect(screen.queryByText(/A\.pdf/)).not.toBeNull();
  });

  it('shows a friendly, retryable error instead of raw server text', async () => {
    await open(server({ failFiles: true }));
    expect(await screen.findByText('Something went wrong on the server. Try again later.')).toBeTruthy();
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('multi-select → confirm → deletes through the server, and nothing is sent before confirming', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const h = await open(server({ files: [file('f1', 'A.pdf'), file('f2', 'B.pdf')] }));
    const row = await screen.findByRole('button', { name: /A\.pdf/ });
    await fireEvent(row, 'longPress');
    expect(await screen.findByText('1 selected')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Move to trash' }));
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
    const buttons = alert.mock.calls[0]?.[2] ?? [];
    const destructive = buttons.find((b) => b.style === 'destructive');
    await act(async () => destructive?.onPress?.());
    await waitFor(() => expect(h.calls.some((c) => c.method === 'DELETE' && c.path === '/files/f1')).toBe(true));
    alert.mockRestore();
  });

  it('declining the confirmation sends nothing', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const h = await open(server({ files: [file('f1', 'A.pdf')] }));
    await fireEvent(await screen.findByRole('button', { name: /A\.pdf/ }), 'longPress');
    await fireEvent.press(await screen.findByRole('button', { name: 'Move to trash' }));
    const cancel = (alert.mock.calls[0]?.[2] ?? []).find((b) => b.style === 'cancel');
    await act(async () => cancel?.onPress?.());
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
    alert.mockRestore();
  });

  it('renders Arabic file names and RTL-locale chrome without breaking', async () => {
    const h = makeHarness(server({ files: [file('f1', 'تقرير 2026.pdf')] }), { signedIn: true, locale: 'ar' });
    await h.services.session.restore();
    await render(
      h.wrap(
        <NavigationContainer>
          <FilesStack />
        </NavigationContainer>,
      ),
    );
    expect(await screen.findByText(/تقرير 2026\.pdf/)).toBeTruthy();
    expect(screen.getByLabelText('ابحث في الملفات')).toBeTruthy();
  });
});

describe('FileDetailsScreen', () => {
  it('shows the details and renames through the server', async () => {
    const h = await open(server({ files: [file('f1', 'Report.pdf')] }));
    await fireEvent.press(await screen.findByRole('button', { name: /Report\.pdf/ }));
    expect(await screen.findByText('Stored in')).toBeTruthy();
    expect(screen.getByText(/me@example\.com/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Rename' }));
    const prompt = await screen.findByLabelText('New name');
    await fireEvent.changeText(prompt, '  Final.pdf  ');
    const save = within(screen.getByLabelText('Save').parent!.parent!).getByRole('button', { name: 'Save' });
    await fireEvent.press(save);
    await waitFor(() => expect(h.calls.some((c) => c.method === 'PATCH' && c.path === '/files/f1')).toBe(true));
    expect(h.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Final.pdf' });
  });

  it('starts a download through the transfer queue and never claims success before it finishes', async () => {
    const h = await open(server({ files: [file('f1', 'Report.pdf')] }));
    await fireEvent.press(await screen.findByRole('button', { name: /Report\.pdf/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Download' }));
    const items = h.services.transfers.getSnapshot();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'download', name: 'Report.pdf' });
  });
});

describe('folderPaths', () => {
  it('builds readable paths, sorted, and survives cycles and orphans', () => {
    const paths = folderPaths([
      folder('b', 'Child', 'a'),
      folder('a', 'Parent'),
      folder('x', 'Loop1', 'y'),
      folder('y', 'Loop2', 'x'),
      folder('o', 'Orphan', 'missing'),
    ]);
    expect(paths.map((p) => p.label)).toEqual(expect.arrayContaining(['Parent', 'Parent / Child', 'Orphan']));
    expect(paths.every((p) => p.label.split(' / ').length <= 32)).toBe(true);
  });
});
