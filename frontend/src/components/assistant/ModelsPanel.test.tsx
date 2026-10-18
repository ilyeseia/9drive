import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), apiFetch: api.apiFetch }))

import { ApiError } from '@/lib/api'
import { ModelsPanel } from '@/components/assistant/ModelsPanel'

const ENV = { enabled: true, reason: null, provider: 'anthropic', model: 'env-model', baseUrlHost: null, keyConfigured: true, limits: {} }
const profile = (over: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'Gateway', provider: 'openai_compatible', model: 'auto', baseUrl: 'https://llm.example.net/v1', hasKey: true, isActive: false, lastTest: null, createdAt: '2026-10-18T10:00:00Z', ...over,
})

let profiles: any[] = []
let activeId: string | null = null
const calls: Array<{ method: string; path: string; body: any }> = []

beforeEach(() => {
  profiles = []
  activeId = null
  calls.length = 0
  window.localStorage.clear()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  api.apiFetch.mockReset()
  api.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    if (method === 'GET' && path === '/ai/admin/models') return { profiles, activeId, environment: ENV, effective: ENV }
    if (method === 'POST' && path === '/ai/admin/models/test') return { ok: true, latencyMs: 55, code: null, model: body.model }
    if (method === 'POST' && path === '/ai/admin/models') {
      const created = profile({ id: 'new', name: body.name, model: body.model })
      profiles = [created]
      return { profile: created }
    }
    if (method === 'PATCH') return { profile: profiles[0] }
    if (method === 'DELETE') { profiles = []; return { status: 'ok' } }
    if (path.endsWith('/activate')) { activeId = 'p1'; profiles = [profile({ isActive: true })]; return { profile: profiles[0] } }
    if (path.endsWith('/use-environment')) { activeId = null; profiles = profiles.map((p) => ({ ...p, isActive: false })); return { status: 'ok' } }
    if (path.endsWith('/test')) { profiles = [profile({ lastTest: { at: 'x', ok: false, code: 'MODEL_AUTH', latencyMs: 9 } })]; return { ok: false, latencyMs: 9, code: 'MODEL_AUTH', model: null, profile: profiles[0] } }
    throw new Error(`unmocked ${method} ${path}`)
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ModelsPanel', () => {
  it('lists the environment as the active source and says when no model was added', async () => {
    render(<ModelsPanel />)
    expect(await screen.findByText('Environment (.env)')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('No models added yet.')).toBeTruthy()
  })

  it('adds a model: tests the typed values first, then saves with the key in the request only', async () => {
    const changed = vi.fn()
    render(<ModelsPanel onChanged={changed} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add model' }))
    const form = screen.getByRole('form', { name: 'Add model' })
    await userEvent.type(within(form).getByLabelText('Name'), 'Gateway')
    await userEvent.type(within(form).getByLabelText('Model'), 'auto')
    await userEvent.type(within(form).getByLabelText(/Base URL/), 'https://llm.example.net/v1')
    await userEvent.type(within(form).getByLabelText(/^API key/), 'sk-secret')
    expect((within(form).getByLabelText(/^API key/) as HTMLInputElement).type).toBe('password')

    await userEvent.click(within(form).getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('Connected (55 ms)')).toBeTruthy()
    expect(calls.find((c) => c.path === '/ai/admin/models/test')?.body).toMatchObject({ name: 'Gateway', model: 'auto', apiKey: 'sk-secret', baseUrl: 'https://llm.example.net/v1' })

    await userEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
    expect(calls.find((c) => c.method === 'POST' && c.path === '/ai/admin/models')?.body).toMatchObject({ provider: 'openai_compatible', apiKey: 'sk-secret' })
    expect(await screen.findByText(/openai_compatible · auto · llm.example.net · Configured/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('sk-secret')
    expect(changed).toHaveBeenCalled()
  })

  it('does not allow saving or testing without a name and a model', async () => {
    render(<ModelsPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add model' }))
    const form = screen.getByRole('form', { name: 'Add model' })
    expect((within(form).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(form).getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('editing without typing a key omits the key so the stored one is kept', async () => {
    profiles = [profile()]
    render(<ModelsPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Gateway' }))
    const form = screen.getByRole('form', { name: 'Edit' })
    expect((within(form).getByLabelText(/^API key/) as HTMLInputElement).value).toBe('')
    await userEvent.clear(within(form).getByLabelText('Model'))
    await userEvent.type(within(form).getByLabelText('Model'), 'auto-2')
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.path).toBe('/ai/admin/models/p1')
    expect(patch.body.model).toBe('auto-2')
    expect('apiKey' in patch.body).toBe(false)
  })

  it('tests a saved model and shows the recorded failure', async () => {
    profiles = [profile()]
    render(<ModelsPanel />)
    expect(await screen.findByText('Not tested')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('Last test failed (MODEL_AUTH)')).toBeTruthy()
  })

  it('activates a model, then switches back to the environment', async () => {
    profiles = [profile()]
    render(<ModelsPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Use' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/ai/admin/models/p1/activate')).toBe(true))
    const envRow = (await screen.findByText('Environment (.env)')).closest('li')!
    await userEvent.click(within(envRow).getByRole('button', { name: 'Use' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/ai/admin/models/use-environment')).toBe(true))
  })

  it('deletes only after confirmation', async () => {
    profiles = [profile()]
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<ModelsPanel />)
    const del = await screen.findByRole('button', { name: 'Delete Gateway' })
    await userEvent.click(del)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await userEvent.click(del)
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/ai/admin/models/p1')).toBe(true))
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('shows the server message when saving fails', async () => {
    const base = api.apiFetch.getMockImplementation()!
    api.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && path === '/ai/admin/models') throw new ApiError('A model with this name already exists.', 409, 'NAME_TAKEN')
      return base(path, init)
    })
    render(<ModelsPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Add model' }))
    const form = screen.getByRole('form', { name: 'Add model' })
    await userEvent.type(within(form).getByLabelText('Name'), 'Gateway')
    await userEvent.type(within(form).getByLabelText('Model'), 'auto')
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already exists')
    expect(screen.getByRole('form', { name: 'Add model' })).toBeTruthy()
  })
})
