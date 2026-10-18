import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), apiFetch: api.apiFetch }))

import { ApiError } from '@/lib/api'
import { AiManagerPage } from '@/pages/AiManagerPage'

const OVERVIEW = {
  config: { enabled: true, reason: null, provider: 'openai_compatible', model: 'auto', baseUrlHost: 'llm.example.net', keyConfigured: true, limits: { maxSteps: 8, dailyTokenLimit: null } },
  toolCount: 32,
  windowDays: 7,
  usage: { inputTokens: 1200, outputTokens: 300, requests: 4, byDay: [], byModel: [{ provider: 'openai_compatible', model: 'auto', inputTokens: 1200, outputTokens: 300, requests: 4 }] },
  tasksByStatus: { COMPLETED: 3, AWAITING_CONFIRMATION: 1 },
  tools: [{ tool: 'list_storage_accounts', succeeded: 5, failed: 1, rejected: 0, avgLatencyMs: 42 }],
  activeTasks: 1,
  recentTasks: [
    { id: 't1', userId: '12345678-aaaa', status: 'AWAITING_CONFIRMATION', stepCount: 2, toolCallCount: 1, provider: 'x', model: 'auto', error: null, createdAt: '2026-10-18T10:00:00Z', finishedAt: null },
    { id: 't2', userId: '87654321-bbbb', status: 'COMPLETED', stepCount: 1, toolCallCount: 0, provider: 'x', model: 'auto', error: null, createdAt: '2026-10-18T09:00:00Z', finishedAt: '2026-10-18T09:00:05Z' },
  ],
}

const MODELS = { profiles: [], activeId: null, environment: OVERVIEW.config, effective: OVERVIEW.config }
const respond = (path: string) => (path.startsWith('/ai/admin/models') ? MODELS : OVERVIEW)

beforeEach(() => {
  window.localStorage.clear()
  api.apiFetch.mockReset()
})
afterEach(cleanup)

describe('AiManagerPage', () => {
  it('shows config without the key value, usage and tasks', async () => {
    api.apiFetch.mockImplementation(async (path: string) => respond(path))
    render(<AiManagerPage />)
    expect(await screen.findByText('llm.example.net')).toBeTruthy()
    expect(screen.getByText('Configured')).toBeTruthy()
    expect(screen.getByText('list_storage_accounts')).toBeTruthy()
    expect(screen.getByText('12345678')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Add model' })).toBeTruthy()
  })

  it('shows a forbidden notice to non-admins', async () => {
    api.apiFetch.mockRejectedValue(new ApiError('Insufficient permissions.', 403, 'FORBIDDEN'))
    render(<AiManagerPage />)
    expect(await screen.findByText('This page is for administrators only.')).toBeTruthy()
  })

  it('runs the connection test and reports the result', async () => {
    api.apiFetch.mockImplementation(async (path: string) => (path.endsWith('/admin/test') ? { ok: true, latencyMs: 87, model: 'auto' } : respond(path)))
    render(<AiManagerPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('Connected (87 ms)')).toBeTruthy()
  })

  it('stops only an active task', async () => {
    api.apiFetch.mockImplementation(async (path: string) => (path.includes('/cancel') ? { task: {} } : respond(path)))
    render(<AiManagerPage />)
    const stops = await screen.findAllByRole('button', { name: /Stop/ })
    expect(stops).toHaveLength(1)
    await userEvent.click(stops[0])
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/ai/admin/tasks/t1/cancel', expect.objectContaining({ method: 'POST' })))
  })
})
