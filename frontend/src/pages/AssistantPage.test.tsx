import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), apiFetch: api.apiFetch }))

import { ApiError } from '@/lib/api'
import { AssistantPage } from '@/pages/AssistantPage'

type Handler = (path: string, init?: RequestInit) => unknown

let routes: Array<[RegExp, Handler]> = []
const calls: Array<{ path: string; method: string; body: any }> = []

function on(method: string, pattern: RegExp, handler: Handler) {
  routes.unshift([new RegExp(`^${method} ${pattern.source}`), handler])
}

beforeEach(() => {
  routes = []
  calls.length = 0
  window.localStorage.clear()
  api.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const hit = routes.find(([pattern]) => pattern.test(`${method} ${path}`))
    if (!hit) throw new Error(`unmocked ${method} ${path}`)
    const out = hit[1](path, init)
    if (out instanceof Error) throw out
    return out
  })
})
afterEach(cleanup)

const ENABLED = { enabled: true, reason: null, provider: 'openai_compatible', model: 'm', tools: 32, locales: ['en', 'ar', 'fr'] }
const DISABLED = { enabled: false, reason: 'AI_PROVIDER is not set.', provider: null, model: null, tools: 32, locales: ['en', 'ar', 'fr'] }
const CONV = { id: 'conv-1', title: 'Hello', locale: 'en', updatedAt: '2026-10-18T10:00:00Z' }
const task = (status: string) => ({ id: 'task-1', conversationId: 'conv-1', status, stepCount: 1, toolCallCount: 0, error: null })
const msg = (seq: number, role: 'user' | 'assistant', content: string) => ({ id: `m${seq}`, seq, role, content, taskId: 'task-1', createdAt: '2026-10-18T10:00:00Z' })

function baseRoutes(status: Record<string, unknown> = ENABLED) {
  on('GET', /\/ai\/status$/, () => status)
  on('GET', /\/ai\/conversations$/, () => ({ conversations: [] }))
  on('POST', /\/ai\/conversations$/, () => ({ conversation: CONV }))
}

const FAST = 5

async function typeAndSend(text: string) {
  const user = userEvent.setup()
  const box = await screen.findByRole('textbox')
  await user.type(box, text)
  await user.click(screen.getByRole('button', { name: 'Send' }))
  return user
}

describe('availability', () => {
  it('shows a clear message when AI is not configured, disables input and still offers read-only quick actions', async () => {
    baseRoutes(DISABLED)
    on('POST', /\/ai\/tools\/list_storage_accounts\/run$/, () => ({ ok: true, summary: 'Retrieved 2 connected storage account(s).', data: { accounts: [{ id: 'a' }] } }))
    render(<AssistantPage pollMs={FAST} />)
    expect((await screen.findByRole('alert')).textContent).toContain('not available')
    expect(screen.getByText(/AI_PROVIDER is not set/)).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    await userEvent.setup().click(screen.getByRole('button', { name: 'My storage accounts' }))
    const result = await screen.findByTestId('quick-result')
    expect(result.textContent).toContain('Retrieved 2 connected storage account(s).')
    expect(calls.some((c) => c.path === '/ai/tools/list_storage_accounts/run' && c.method === 'POST')).toBe(true)
    // No chat request is ever made while AI is disabled.
    expect(calls.some((c) => c.path.includes('/messages'))).toBe(false)
  })
})

describe('conversation flow', () => {
  it('sends a message, shows progress, then the assistant answer and a completed outcome', async () => {
    baseRoutes()
    let polls = 0
    on('POST', /\/ai\/conversations\/conv-1\/messages$/, () => ({ task: task('RECEIVED') }))
    on('GET', /\/ai\/tasks\/task-1/, () => {
      polls += 1
      if (polls === 1) return { task: task('EXECUTING'), steps: [], confirmation: null, messages: [msg(1, 'user', 'list my accounts')] }
      return {
        task: task('COMPLETED'),
        steps: [{ id: 's1', tool: 'list_storage_accounts', status: 'SUCCEEDED', summary: 'Retrieved 2 connected storage account(s).', verification: null, errorCode: null, userOutput: null }],
        confirmation: null,
        messages: [msg(4, 'assistant', 'You have 2 accounts: <b>Drive</b> and S3.')],
      }
    })
    render(<AssistantPage pollMs={FAST} />)
    await typeAndSend('list my accounts')
    expect(await screen.findByTestId('busy-indicator')).toBeTruthy()
    const outcome = await screen.findByTestId('task-outcome')
    expect(outcome.textContent).toContain('Done')
    // Assistant text is rendered as plain text, never as HTML.
    expect(screen.getByText('You have 2 accounts: <b>Drive</b> and S3.')).toBeTruthy()
    expect(document.querySelector('b')).toBeNull()
    expect(screen.getByText('Retrieved 2 connected storage account(s).')).toBeTruthy()
    expect(screen.getAllByText('list my accounts')).toHaveLength(1)
    // Chronology: the executed step is shown before the assistant's final answer.
    const step = screen.getByTestId('step')
    const answer = screen.getByText('You have 2 accounts: <b>Drive</b> and S3.')
    expect(step.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const send = calls.find((c) => c.path.endsWith('/messages'))!
    expect(send.body).toEqual({ text: 'list my accounts', locale: 'en' })
  })

  it('submits with Enter but not with Shift+Enter (keyboard)', async () => {
    baseRoutes()
    on('POST', /\/ai\/conversations\/conv-1\/messages$/, () => ({ task: task('RECEIVED') }))
    on('GET', /\/ai\/tasks\/task-1/, () => ({ task: task('COMPLETED'), steps: [], confirmation: null, messages: [] }))
    render(<AssistantPage pollMs={FAST} />)
    const box = (await screen.findByRole('textbox')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(calls.some((c) => c.path.endsWith('/messages'))).toBe(false)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/messages'))).toBe(true))
  })

  it('shows a translated error and restores the text when sending fails', async () => {
    baseRoutes()
    on('POST', /\/ai\/conversations\/conv-1\/messages$/, () => new ApiError('Another request is running', 409, 'TASK_IN_PROGRESS'))
    render(<AssistantPage pollMs={FAST} />)
    await typeAndSend('retry me')
    expect((await screen.findByRole('alert')).textContent).toContain('still running')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('retry me')
  })

  it('offers Retry for a failed task and shows the failed state', async () => {
    baseRoutes()
    on('POST', /\/ai\/conversations\/conv-1\/messages$/, () => ({ task: task('RECEIVED') }))
    on('GET', /\/ai\/tasks\/task-1/, () => ({ task: { ...task('FAILED'), error: 'MODEL_RATE_LIMITED' }, steps: [], confirmation: null, messages: [msg(1, 'user', 'q'), msg(2, 'assistant', 'I could not get an answer from the AI model.')] }))
    render(<AssistantPage pollMs={FAST} />)
    await typeAndSend('q')
    const outcome = await screen.findByTestId('task-outcome')
    expect(outcome.textContent).toContain('Failed')
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
  })
})

describe('confirmation workflow', () => {
  const card = {
    id: 'conf-1', status: 'PENDING', tool: 'trash_files', risk: 'medium', summary: 'Move 2 file(s) to the Recycle Bin',
    preview: { affectedCount: 2, sample: ['a.pdf', 'b.pdf'], warnings: [] }, argsHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }

  function startAwaiting() {
    baseRoutes()
    let approved = false
    let rejected = false
    on('POST', /\/ai\/conversations\/conv-1\/messages$/, () => ({ task: task('RECEIVED') }))
    on('GET', /\/ai\/tasks\/task-1/, () => {
      if (approved) return { task: task('COMPLETED'), steps: [{ id: 's1', tool: 'trash_files', status: 'SUCCEEDED', summary: 'Moved 2 file(s) to the Recycle Bin.', verification: 'Re-read: 2 of 2 file(s) are now in the Recycle Bin.', errorCode: null, userOutput: null }], confirmation: null, messages: [msg(5, 'assistant', 'Done.')] }
      if (rejected) return { task: task('COMPLETED'), steps: [{ id: 's1', tool: 'trash_files', status: 'REJECTED', summary: 'The user declined this action.', verification: null, errorCode: 'DECLINED', userOutput: null }], confirmation: null, messages: [msg(5, 'assistant', 'Okay, nothing was deleted.')] }
      return { task: task('AWAITING_CONFIRMATION'), steps: [{ id: 's1', tool: 'trash_files', status: 'PENDING_CONFIRMATION', summary: card.summary, verification: null, errorCode: null, userOutput: null }], confirmation: card, messages: [msg(1, 'user', 'delete a and b')] }
    })
    on('POST', /\/ai\/confirmations\/conf-1\/approve$/, () => {
      approved = true
      return { task: task('EXECUTING') }
    })
    on('POST', /\/ai\/confirmations\/conf-1\/reject$/, () => {
      rejected = true
      return { task: task('ANALYZING') }
    })
  }

  it('pauses on a card, sends the shown hash on approval, then reports the verified result', async () => {
    startAwaiting()
    render(<AssistantPage pollMs={FAST} />)
    await typeAndSend('delete a and b')
    expect(await screen.findByTestId('confirmation-card')).toBeTruthy()
    // Typing is locked while waiting for the user's decision.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Done.')
    const approve = calls.find((c) => c.path.endsWith('/approve'))!
    expect(approve.body).toEqual({ argsHash: card.argsHash })
    expect(screen.getByText(/Verified: Re-read: 2 of 2/)).toBeTruthy()
    expect(screen.queryByTestId('confirmation-card')).toBeNull()
    expect((await screen.findByTestId('task-outcome')).textContent).toContain('Done')
  })

  it('records a decline and lets the conversation continue', async () => {
    startAwaiting()
    render(<AssistantPage pollMs={FAST} />)
    await typeAndSend('delete a and b')
    await screen.findByTestId('confirmation-card')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Decline' }))
    await screen.findByText('Okay, nothing was deleted.')
    expect(calls.some((c) => c.path.endsWith('/reject'))).toBe(true)
    expect(calls.some((c) => c.path.endsWith('/approve'))).toBe(false)
    expect(screen.getByText('Not executed')).toBeTruthy()
  })

  it('shows a translated error when an approval is rejected by the server (expired/replayed)', async () => {
    startAwaiting()
    on('POST', /\/ai\/confirmations\/conf-1\/approve$/, () => new ApiError('expired', 410, 'CONFIRMATION_EXPIRED'))
    render(<AssistantPage pollMs={FAST} />)
    await typeAndSend('delete a and b')
    await screen.findByTestId('confirmation-card')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already used or has expired')
  })

  it('cancels a task that is waiting for approval', async () => {
    startAwaiting()
    on('POST', /\/ai\/tasks\/task-1\/cancel$/, () => ({ task: task('CANCELLED') }))
    render(<AssistantPage pollMs={FAST} />)
    await typeAndSend('delete a and b')
    await screen.findByTestId('confirmation-card')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(true))
  })
})

describe('share-link output', () => {
  it('shows a share URL to the user only and offers to copy it', async () => {
    baseRoutes()
    on('POST', /\/ai\/conversations\/conv-1\/messages$/, () => ({ task: task('RECEIVED') }))
    on('GET', /\/ai\/tasks\/task-1/, () => ({
      task: task('COMPLETED'),
      steps: [{ id: 's1', tool: 'create_share_link', status: 'SUCCEEDED', summary: 'Created a public share link.', verification: null, errorCode: null, userOutput: { url: 'https://drive.example/public/files/TOKEN123' } }],
      confirmation: null,
      messages: [msg(3, 'assistant', 'The link was created; it is shown above.')],
    }))
    render(<AssistantPage pollMs={FAST} />)
    await typeAndSend('share it')
    expect((await screen.findByText('https://drive.example/public/files/TOKEN123')).getAttribute('dir')).toBe('ltr')
    expect(screen.getByText(/assistant cannot see it/)).toBeTruthy()
  })
})

describe('languages and layout direction', () => {
  it('switches to Arabic with right-to-left layout and translated controls', async () => {
    baseRoutes()
    render(<AssistantPage pollMs={FAST} />)
    const select = await screen.findByLabelText('Language')
    expect(screen.getByTestId('assistant-root').getAttribute('dir')).toBe('ltr')
    fireEvent.change(select, { target: { value: 'ar' } })
    const root = await screen.findByTestId('assistant-root')
    expect(root.getAttribute('dir')).toBe('rtl')
    expect(root.getAttribute('lang')).toBe('ar')
    expect(screen.getByText('مساعد 9Drive الذكي')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'إرسال' })).toBeTruthy()
    expect(window.localStorage.getItem('9drive.locale')).toBe('ar')
  })

  it('switches to French and sends the chosen locale with the message', async () => {
    baseRoutes()
    on('POST', /\/ai\/conversations\/conv-1\/messages$/, () => ({ task: task('RECEIVED') }))
    on('GET', /\/ai\/tasks\/task-1/, () => ({ task: task('COMPLETED'), steps: [], confirmation: null, messages: [] }))
    render(<AssistantPage pollMs={FAST} />)
    fireEvent.change(await screen.findByLabelText('Language'), { target: { value: 'fr' } })
    expect(await screen.findByText('Assistant IA 9Drive')).toBeTruthy()
    expect(screen.getByTestId('assistant-root').getAttribute('dir')).toBe('ltr')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bonjour' } })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Envoyer' }))
    await waitFor(() => expect(calls.find((c) => c.path.endsWith('/messages'))?.body).toEqual({ text: 'bonjour', locale: 'fr' }))
  })

  it('uses a stored language preference on load', async () => {
    window.localStorage.setItem('9drive.locale', 'ar')
    baseRoutes()
    render(<AssistantPage pollMs={FAST} />)
    expect(await screen.findByText('مساعد 9Drive الذكي')).toBeTruthy()
    expect(screen.getByTestId('assistant-root').getAttribute('dir')).toBe('rtl')
  })
})

describe('conversation list', () => {
  it('loads a past conversation and resumes an active task (confirmation card survives a reload)', async () => {
    on('GET', /\/ai\/status$/, () => ENABLED)
    on('GET', /\/ai\/conversations$/, () => ({ conversations: [CONV] }))
    on('GET', /\/ai\/conversations\/conv-1$/, () => ({ conversation: CONV, messages: [msg(1, 'user', 'delete a')], activeTaskId: 'task-1' }))
    on('GET', /\/ai\/tasks\/task-1/, () => ({
      task: task('AWAITING_CONFIRMATION'), steps: [],
      confirmation: { id: 'c9', status: 'PENDING', tool: 'trash_files', risk: 'medium', summary: 'Move 1 file(s) to the Recycle Bin', preview: null, argsHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 120_000).toISOString() },
      messages: [],
    }))
    render(<AssistantPage pollMs={FAST} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Hello' }))
    expect(await screen.findByTestId('confirmation-card')).toBeTruthy()
    expect(screen.getByText('delete a')).toBeTruthy()
  })

  it('deletes a conversation only after the user confirms', async () => {
    on('GET', /\/ai\/status$/, () => ENABLED)
    on('GET', /\/ai\/conversations$/, () => ({ conversations: [CONV] }))
    on('DELETE', /\/ai\/conversations\/conv-1$/, () => ({ status: 'ok' }))
    const confirm = vi.spyOn(window, 'confirm')
    render(<AssistantPage pollMs={FAST} />)
    const remove = await screen.findByRole('button', { name: /Delete conversation: Hello/ })
    confirm.mockReturnValueOnce(false)
    await userEvent.setup().click(remove)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    confirm.mockReturnValueOnce(true)
    await userEvent.setup().click(remove)
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Hello' })).toBeNull())
    confirm.mockRestore()
  })
})
