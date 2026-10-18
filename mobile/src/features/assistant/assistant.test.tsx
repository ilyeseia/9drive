import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { aiErrorKey, humanizeTool, mergeMessages, remainingTime } from '../../api/endpoints/ai';
import { ApiError } from '../../api/errors';
import { json, makeHarness, type Handler } from '../../test/helpers';
import { parseBlocks, parseInline } from '../../ui/Markdown';
import { AssistantScreen } from './AssistantScreen';

jest.mock('../../transfers/device', () => ({
  DeviceFileSource: class {},
  chunkFetch: jest.fn(),
  clearDownloadCache: jest.fn(),
  createDownloader: jest.fn(),
  prefsTransferPersistence: { load: async () => [], save: async () => undefined },
}));

const Stack = createNativeStackNavigator();
const HASH = 'a'.repeat(64);
const msg = (seq: number, role: 'user' | 'assistant', content: string) => ({
  id: `m${seq}`,
  seq,
  role,
  content,
  taskId: 't1',
  createdAt: '2026-10-18T10:00:00Z',
});
const task = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 't1',
  conversationId: 'c1',
  status,
  stepCount: 1,
  toolCallCount: 1,
  error: null,
  ...extra,
});
const confirmation = (over: Record<string, unknown> = {}) => ({
  id: 'conf1',
  status: 'PENDING',
  tool: 'trash_files',
  risk: 'medium',
  summary: 'Move 2 files to the trash',
  preview: { affectedCount: 2, sample: ['a.pdf', 'b.pdf'], warnings: ['Shared links to these files will stop working.'] },
  argsHash: HASH,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  ...over,
});

interface Script {
  enabled?: boolean;
  /** Task views returned by successive polls; the last one repeats. */
  views: {
    task: ReturnType<typeof task>;
    steps?: unknown[];
    confirmation?: ReturnType<typeof confirmation> | null;
    messages?: ReturnType<typeof msg>[];
  }[];
  failPolls?: boolean;
  approveStatus?: { status: number; code: string };
}

function server(script: Script) {
  let polls = 0;
  const handler: Handler = ({ path, method }) => {
    if (path === '/ai/status')
      return json({
        enabled: script.enabled ?? true,
        reason: script.enabled === false ? 'AI_PROVIDER is not set.' : null,
        provider: 'openai_compatible',
        model: 'auto',
        tools: 32,
      });
    if (path === '/ai/conversations' && method === 'POST')
      return json({ conversation: { id: 'c1', title: '', locale: 'en', updatedAt: '2026-10-18T10:00:00Z' } }, 201);
    if (path === '/ai/conversations/c1' && method === 'GET')
      return json({ conversation: { id: 'c1', title: '', locale: 'en' }, messages: [], activeTaskId: null });
    if (path === '/ai/conversations/c1/messages') return json({ task: task('RECEIVED') }, 202);
    if (path === '/ai/tasks/t1' && method === 'GET') {
      if (script.failPolls) return json({ code: 'INTERNAL_SERVER_ERROR', message: 'x' }, 500);
      const view = script.views[Math.min(polls, script.views.length - 1)]!;
      polls += 1;
      return json({ task: view.task, steps: view.steps ?? [], confirmation: view.confirmation ?? null, messages: view.messages ?? [] });
    }
    if (path === '/ai/tasks/t1/cancel') return json({ task: task('CANCELLED') });
    if (path === '/ai/confirmations/conf1/approve')
      return script.approveStatus
        ? json({ code: script.approveStatus.code, message: 'x' }, script.approveStatus.status)
        : json({ task: task('EXECUTING') });
    if (path === '/ai/confirmations/conf1/reject') return json({ task: task('CANCELLED') });
    return json({ code: 'NOT_FOUND', message: 'x' }, 404);
  };
  return { handler, polls: () => polls };
}

async function open(script: Script, locale: 'en' | 'ar' | 'fr' = 'en') {
  const s = server(script);
  const h = makeHarness(s.handler, { signedIn: true, locale });
  await h.services.session.restore();
  await render(
    h.wrap(
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Chat">{() => <AssistantScreen pollMs={15} />}</Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>,
    ),
  );
  return { ...h, polls: s.polls };
}

async function ask(text: string) {
  await fireEvent.changeText(await screen.findByLabelText('Ask about your storage…'), text);
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
}

const finish = (answer: string) => ({
  task: task('COMPLETED'),
  steps: [
    { id: 's1', tool: 'list_storage_accounts', status: 'SUCCEEDED', summary: 'Retrieved 2 accounts', verification: null, errorCode: null },
  ],
  messages: [msg(1, 'user', 'hello'), msg(2, 'assistant', answer)],
});

describe('AssistantScreen', () => {
  it('explains when the assistant is not configured and offers no input', async () => {
    await open({ enabled: false, views: [] });
    expect(await screen.findByText('The AI assistant is not available')).toBeTruthy();
    expect(screen.getByText('AI_PROVIDER is not set.')).toBeTruthy();
    expect(screen.queryByLabelText('Ask about your storage…')).toBeNull();
  });

  it('creates a chat, sends the message, polls progress and shows the answer as formatted text with its steps', async () => {
    const h = await open({
      views: [
        { task: task('ANALYZING'), messages: [msg(1, 'user', 'my accounts?')] },
        { task: task('EXECUTING'), messages: [] },
        finish('You have **2 accounts**.\n\n- Drive\n- Dropbox'),
      ],
    });
    await ask('my accounts?');
    expect(await screen.findByText(/You have/)).toBeTruthy();
    expect(screen.getByText('2 accounts')).toBeTruthy();
    expect(screen.getByText('Drive')).toBeTruthy();
    expect(await screen.findByText(/list storage accounts · Done/)).toBeTruthy();
    expect(h.calls.some((c) => c.path === '/ai/conversations' && c.method === 'POST')).toBe(true);
    expect(h.calls.find((c) => c.path === '/ai/conversations/c1/messages')?.body).toEqual({ text: 'my accounts?', locale: 'en' });
    // polling stops once the task finished
    const before = h.polls();
    await new Promise((r) => setTimeout(r, 120));
    expect(h.polls()).toBe(before);
  });

  it('renders model output as plain text: no markup, no tappable links', async () => {
    await open({ views: [finish('<script>alert(1)</script> [click](javascript:alert(2)) and [docs](https://example.com/x)')] });
    await ask('hi');
    expect(await screen.findByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(screen.getByText(/click \(javascript:alert\(2\)\)/)).toBeTruthy(); // visible, inert
    expect(screen.getByText(/docs \(https:\/\/example\.com\/x\)/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows a proposal card and sends nothing destructive until the user approves with the shown hash', async () => {
    const h = await open({
      views: [{ task: task('AWAITING_CONFIRMATION'), confirmation: confirmation(), messages: [msg(1, 'user', 'delete')] }, finish('Done.')],
    });
    await ask('delete old files');
    expect(await screen.findByText('Approval needed')).toBeTruthy();
    expect(screen.getByText('Medium risk')).toBeTruthy();
    expect(screen.getByText('Move 2 files to the trash')).toBeTruthy();
    expect(screen.getByText(/2 item\(s\) affected/)).toBeTruthy();
    expect(screen.getByText(/Shared links to these files will stop working/)).toBeTruthy();
    expect(screen.getByText(/This is a proposal/)).toBeTruthy();
    expect(h.calls.some((c) => c.path.startsWith('/ai/confirmations'))).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(h.calls.find((c) => c.path === '/ai/confirmations/conf1/approve')?.body).toEqual({ argsHash: HASH }));
    expect(await screen.findByText(/Done\./)).toBeTruthy();
  });

  it('requires an explicit acknowledgement for high-risk actions', async () => {
    const h = await open({
      views: [{ task: task('AWAITING_CONFIRMATION'), confirmation: confirmation({ risk: 'high', summary: 'Permanently delete 5 files' }) }],
    });
    await ask('purge');
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    await fireEvent.press(approve);
    expect(h.calls.some((c) => c.path.includes('/approve'))).toBe(false);
    await fireEvent.press(screen.getByRole('checkbox', { name: /cannot be undone/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled());
  });

  it('declines a proposal through the server', async () => {
    const h = await open({ views: [{ task: task('AWAITING_CONFIRMATION'), confirmation: confirmation() }, { task: task('CANCELLED') }] });
    await ask('x');
    await fireEvent.press(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(h.calls.some((c) => c.path === '/ai/confirmations/conf1/reject')).toBe(true));
  });

  it('disables approval of an expired proposal', async () => {
    await open({
      views: [
        { task: task('AWAITING_CONFIRMATION'), confirmation: confirmation({ expiresAt: new Date(Date.now() - 1000).toISOString() }) },
      ],
    });
    await ask('x');
    expect(await screen.findByText(/approval expired/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('shows the server’s specific message when an approval is rejected as changed, then refreshes the state', async () => {
    await open({
      views: [{ task: task('AWAITING_CONFIRMATION'), confirmation: confirmation() }],
      approveStatus: { status: 409, code: 'CONFIRMATION_MISMATCH' },
    });
    await ask('x');
    await fireEvent.press(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('The action changed after it was shown. Review it again.')).toBeTruthy();
  });

  it('can stop a running request', async () => {
    const h = await open({ views: [{ task: task('EXECUTING') }] });
    await ask('long job');
    await fireEvent.press(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(h.calls.some((c) => c.path === '/ai/tasks/t1/cancel')).toBe(true));
  });

  it('gives up polling after repeated failures and lets the user retry, without raw server text', async () => {
    await open({ views: [{ task: task('ANALYZING') }], failPolls: true });
    await ask('x');
    expect(await screen.findByText('Something went wrong on the server. Try again later.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('works in Arabic with Arabic content', async () => {
    await open({ views: [finish('لديك **حسابان**.')] }, 'ar');
    await fireEvent.changeText(await screen.findByLabelText('اسأل عن تخزينك…'), 'حساباتي؟');
    await fireEvent.press(screen.getByRole('button', { name: 'إرسال' }));
    expect(await screen.findByText('حسابان')).toBeTruthy();
  });
});

describe('helpers', () => {
  it('maps AI error codes to specific messages', () => {
    const e = (code: string) => new ApiError('conflict', 409, code, 'x');
    expect(aiErrorKey(e('TASK_IN_PROGRESS'))).toBe('errAiBusy');
    expect(aiErrorKey(e('USAGE_LIMIT_REACHED'))).toBe('errAiLimit');
    expect(aiErrorKey(e('CONFIRMATION_MISMATCH'))).toBe('errAiMismatch');
    expect(aiErrorKey(e('CONFIRMATION_EXPIRED'))).toBe('errAiConfirmationUsed');
    expect(aiErrorKey(e('SOMETHING'))).toBeNull();
    expect(aiErrorKey(new Error('x'))).toBeNull();
  });

  it('formats the countdown, merges messages idempotently and sanitises tool names', () => {
    const now = Date.parse('2026-10-18T10:00:00Z');
    expect(remainingTime('2026-10-18T10:04:05Z', now)).toBe('04:05');
    expect(remainingTime('2026-10-18T09:59:00Z', now)).toBeNull();
    const merged = mergeMessages([msg(1, 'user', 'a')], [msg(2, 'assistant', 'b'), msg(1, 'user', 'a')]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2]);
    expect(humanizeTool('trash_files')).toBe('trash files');
    expect(humanizeTool('<b>x</b>_y')).not.toMatch(/[<>/]/);
  });
});

describe('Markdown parsing', () => {
  it('parses blocks and inline styles, with links inert', () => {
    expect(parseBlocks('# T\n\n- a\n- b\n\n1. x\n\n```\ncode\n```\n\n| H | I |\n| - | - |\n| 1 | 2 |').map((b) => b.kind)).toEqual([
      'heading',
      'ul',
      'ol',
      'code',
      'table',
    ]);
    expect(parseInline('a **b** `c` *d* [t](https://u.example)')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'bold', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'c' },
      { type: 'text', text: ' ' },
      { type: 'italic', children: [{ type: 'text', text: 'd' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 't (https://u.example)' },
    ]);
  });

  it('survives unbalanced input', () => {
    expect(() => parseBlocks('**open ` tick | pipe\n- \n```\nunclosed')).not.toThrow();
    expect(parseBlocks('')).toEqual([]);
  });
});
