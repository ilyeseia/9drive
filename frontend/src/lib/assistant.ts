/** Typed client and pure helpers for the AI assistant API (`/ai/*`). No secrets live in the browser. */

import { apiFetch, ApiError } from '@/lib/api'
import type { Locale, MessageKey } from '@/lib/i18n'

export type TaskStatus =
  | 'RECEIVED'
  | 'ANALYZING'
  | 'AWAITING_CLARIFICATION'
  | 'AWAITING_CONFIRMATION'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'PARTIALLY_COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export interface AssistantStatus {
  enabled: boolean
  reason: string | null
  provider: string | null
  model: string | null
  tools: number
  locales: Locale[]
}

export interface ConversationSummary {
  id: string
  title: string
  locale: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  taskId: string | null
  createdAt: string
}

export interface TaskDto {
  id: string
  conversationId: string
  status: TaskStatus
  stepCount: number
  toolCallCount: number
  error: string | null
}

export interface StepDto {
  id: string
  tool: string
  status: 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'PENDING_CONFIRMATION' | 'SKIPPED'
  summary: string | null
  verification: string | null
  errorCode: string | null
  userOutput: Record<string, unknown> | null
}

export interface ConfirmationDto {
  id: string
  status: string
  tool: string
  risk: 'low' | 'medium' | 'high'
  summary: string
  preview: { affectedCount?: number; sample?: string[]; warnings?: string[] } | null
  argsHash: string
  expiresAt: string
}

export interface TaskView {
  task: TaskDto
  steps: StepDto[]
  confirmation: ConfirmationDto | null
  messages: ChatMessage[]
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const assistantApi = {
  status: () => apiFetch<AssistantStatus>('/ai/status'),
  listConversations: () => apiFetch<{ conversations: ConversationSummary[] }>('/ai/conversations'),
  createConversation: (locale: Locale) => apiFetch<{ conversation: ConversationSummary }>('/ai/conversations', json({ locale })),
  getConversation: (id: string) =>
    apiFetch<{ conversation: { id: string; title: string; locale: string }; messages: ChatMessage[]; activeTaskId: string | null }>(`/ai/conversations/${id}`),
  deleteConversation: (id: string) => apiFetch<{ status: string }>(`/ai/conversations/${id}`, { method: 'DELETE' }),
  sendMessage: (conversationId: string, text: string, locale: Locale) =>
    apiFetch<{ task: TaskDto }>(`/ai/conversations/${conversationId}/messages`, json({ text, locale })),
  getTask: (taskId: string, afterSeq: number) => apiFetch<TaskView>(`/ai/tasks/${taskId}?afterSeq=${afterSeq}`),
  cancelTask: (taskId: string) => apiFetch<{ task: TaskDto }>(`/ai/tasks/${taskId}/cancel`, json({})),
  approve: (confirmationId: string, argsHash: string) => apiFetch<{ task: TaskDto }>(`/ai/confirmations/${confirmationId}/approve`, json({ argsHash })),
  reject: (confirmationId: string) => apiFetch<{ task: TaskDto }>(`/ai/confirmations/${confirmationId}/reject`, json({})),
  runTool: (name: string, args: Record<string, unknown> = {}) =>
    apiFetch<{ ok: true; summary: string; data: unknown }>(`/ai/tools/${name}/run`, json({ args })),
}

const FINISHED: ReadonlySet<TaskStatus> = new Set(['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED', 'AWAITING_CLARIFICATION'])
const BUSY: ReadonlySet<TaskStatus> = new Set(['RECEIVED', 'ANALYZING', 'EXECUTING', 'VERIFYING'])

export const isFinished = (status: TaskStatus): boolean => FINISHED.has(status)
export const isBusy = (status: TaskStatus): boolean => BUSY.has(status)
/** Keep polling while the server is working; pause while the user must decide. */
export const shouldPoll = (status: TaskStatus): boolean => isBusy(status)

export const STATUS_KEYS: Record<TaskStatus, MessageKey> = {
  RECEIVED: 'statusReceived',
  ANALYZING: 'statusAnalyzing',
  EXECUTING: 'statusExecuting',
  VERIFYING: 'statusVerifying',
  AWAITING_CONFIRMATION: 'statusAwaitingConfirmation',
  AWAITING_CLARIFICATION: 'statusAwaitingClarification',
  COMPLETED: 'statusCompleted',
  PARTIALLY_COMPLETED: 'statusPartiallyCompleted',
  FAILED: 'statusFailed',
  CANCELLED: 'statusCancelled',
}

export const STEP_KEYS: Record<StepDto['status'], MessageKey> = {
  SUCCEEDED: 'stepSucceeded',
  FAILED: 'stepFailed',
  REJECTED: 'stepRejected',
  PENDING_CONFIRMATION: 'stepPending',
  SKIPPED: 'stepSkipped',
}

export const RISK_KEYS: Record<ConfirmationDto['risk'], MessageKey> = {
  low: 'confirmRiskLow',
  medium: 'confirmRiskMedium',
  high: 'confirmRiskHigh',
}

/** Maps API error codes to a translatable message key (never shows raw server text for known codes). */
export function errorKeyFor(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) return 'errorGeneric'
  switch (error.code) {
    case 'TASK_IN_PROGRESS':
      return 'errorBusy'
    case 'RATE_LIMITED':
    case 'TOO_MANY_TASKS':
    case 'SERVER_BUSY':
      return 'errorRateLimited'
    case 'AI_NOT_CONFIGURED':
      return 'errorNotConfigured'
    case 'USAGE_LIMIT_REACHED':
      return 'errorLimit'
    case 'CONFIRMATION_MISMATCH':
      return 'errorMismatch'
    case 'CONFIRMATION_USED':
    case 'CONFIRMATION_EXPIRED':
    case 'CONFIRMATION_INVALID':
      return 'errorConfirmationUsed'
    default:
      return 'errorGeneric'
  }
}

/** `mm:ss` until `expiresAt`, or `null` once it has passed. */
export function remainingTime(expiresAt: string, now: number): string | null {
  const ms = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return null
  const total = Math.ceil(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function humanizeTool(name: string): string {
  return name.replace(/_/g, ' ')
}

/** Merge polled messages into the transcript by sequence number (idempotent). */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const bySeq = new Map(current.map((m) => [m.seq, m]))
  for (const message of incoming) bySeq.set(message.seq, message)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export interface AdminOverview {
  config: {
    enabled: boolean
    reason: string | null
    provider: string | null
    model: string | null
    baseUrlHost: string | null
    keyConfigured: boolean
    limits: Record<string, number | null>
  }
  toolCount: number
  windowDays: number
  usage: {
    inputTokens: number
    outputTokens: number
    requests: number
    byDay: Array<{ day: string; inputTokens: number; outputTokens: number }>
    byModel: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; requests: number }>
  }
  tasksByStatus: Record<string, number>
  tools: Array<{ tool: string; succeeded: number; failed: number; rejected: number; avgLatencyMs: number | null }>
  activeTasks: number
  recentTasks: Array<{
    id: string
    userId: string
    status: TaskStatus
    stepCount: number
    toolCallCount: number
    provider: string | null
    model: string | null
    error: string | null
    createdAt: string
    finishedAt: string | null
  }>
}

export type AdminTestResult = { ok: true; latencyMs: number; model: string } | { ok: false; latencyMs: number; code: string }

/** Admin-only endpoints; the server answers 403 to everyone else. */
export const assistantAdminApi = {
  overview: () => apiFetch<AdminOverview>('/ai/admin/overview'),
  test: () => apiFetch<AdminTestResult>('/ai/admin/test', json({})),
  cancelTask: (taskId: string) => apiFetch<{ task: TaskDto }>(`/ai/admin/tasks/${taskId}/cancel`, json({})),
}

export interface ModelProfile {
  id: string
  name: string
  provider: 'openai_compatible' | 'anthropic' | string
  model: string
  baseUrl: string | null
  hasKey: boolean
  isActive: boolean
  lastTest: { at: string; ok: boolean; code: string | null; latencyMs: number | null } | null
  createdAt: string
}

export type AdminConfigView = AdminOverview['config']

export interface ModelsResponse {
  profiles: ModelProfile[]
  activeId: string | null
  /** Set when the stored active model cannot be used (e.g. its key can no longer be decrypted). */
  activeProblem: 'KEY_UNREADABLE' | 'INVALID' | null
  environment: AdminConfigView
  effective: AdminConfigView
}

export interface ModelInput {
  name: string
  provider: string
  model: string
  baseUrl: string | null
  /** Omit to keep the stored key when editing; never read back from the server. */
  apiKey?: string
}

export interface ProbeOutcome {
  ok: boolean
  latencyMs: number
  code: string | null
  model: string | null
}

const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) })

export const modelsApi = {
  list: () => apiFetch<ModelsResponse>('/ai/admin/models'),
  create: (input: ModelInput) => apiFetch<{ profile: ModelProfile }>('/ai/admin/models', json(input)),
  update: (id: string, input: Partial<ModelInput>) => apiFetch<{ profile: ModelProfile }>(`/ai/admin/models/${id}`, patch(input)),
  remove: (id: string) => apiFetch<{ status: string }>(`/ai/admin/models/${id}`, { method: 'DELETE' }),
  activate: (id: string) => apiFetch<{ profile: ModelProfile }>(`/ai/admin/models/${id}/activate`, json({})),
  useEnvironment: () => apiFetch<{ status: string }>('/ai/admin/models/use-environment', json({})),
  test: (id: string) => apiFetch<ProbeOutcome & { profile: ModelProfile }>(`/ai/admin/models/${id}/test`, json({})),
  testDraft: (input: ModelInput, existingId?: string) => apiFetch<ProbeOutcome>('/ai/admin/models/test', json({ ...input, existingId })),
}

export const isActiveStatus = (status: TaskStatus): boolean => !isFinished(status)
