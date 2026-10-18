import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  RISK_KEYS,
  STATUS_KEYS,
  STEP_KEYS,
  errorKeyFor,
  humanizeTool,
  isBusy,
  isFinished,
  mergeMessages,
  remainingTime,
  shouldPoll,
  type ChatMessage,
  type TaskStatus,
} from '@/lib/assistant'
import { DICTIONARIES } from '@/lib/i18n'

const ALL: TaskStatus[] = ['RECEIVED', 'ANALYZING', 'AWAITING_CLARIFICATION', 'AWAITING_CONFIRMATION', 'EXECUTING', 'VERIFYING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED']

describe('task status helpers', () => {
  it('classifies every status exactly once: busy, finished, or waiting for the user', () => {
    for (const status of ALL) {
      const kinds = [isBusy(status), isFinished(status), status === 'AWAITING_CONFIRMATION'].filter(Boolean)
      expect(kinds, status).toHaveLength(1)
    }
  })

  it('polls only while the server is working', () => {
    expect(ALL.filter(shouldPoll).sort()).toEqual(['ANALYZING', 'EXECUTING', 'RECEIVED', 'VERIFYING'])
    expect(shouldPoll('AWAITING_CONFIRMATION')).toBe(false)
  })

  it('has a translation for every status, step state and risk level', () => {
    for (const status of ALL) expect(DICTIONARIES.en[STATUS_KEYS[status]]).toBeTruthy()
    for (const key of Object.values(STEP_KEYS)) expect(DICTIONARIES.ar[key]).toBeTruthy()
    for (const key of Object.values(RISK_KEYS)) expect(DICTIONARIES.fr[key]).toBeTruthy()
  })
})

describe('error mapping', () => {
  it('maps API codes to translatable messages and never surfaces raw server text', () => {
    expect(errorKeyFor(new ApiError('Another request…', 409, 'TASK_IN_PROGRESS'))).toBe('errorBusy')
    expect(errorKeyFor(new ApiError('x', 429, 'RATE_LIMITED'))).toBe('errorRateLimited')
    expect(errorKeyFor(new ApiError('x', 503, 'AI_NOT_CONFIGURED'))).toBe('errorNotConfigured')
    expect(errorKeyFor(new ApiError('x', 429, 'USAGE_LIMIT_REACHED'))).toBe('errorLimit')
    expect(errorKeyFor(new ApiError('x', 409, 'CONFIRMATION_MISMATCH'))).toBe('errorMismatch')
    expect(errorKeyFor(new ApiError('x', 410, 'CONFIRMATION_EXPIRED'))).toBe('errorConfirmationUsed')
    expect(errorKeyFor(new ApiError('boom <script>', 500, 'WHATEVER'))).toBe('errorGeneric')
    expect(errorKeyFor(new Error('network'))).toBe('errorGeneric')
  })
})

describe('formatting and merging', () => {
  it('formats the confirmation countdown and returns null after expiry', () => {
    const now = Date.parse('2026-10-18T10:00:00Z')
    expect(remainingTime('2026-10-18T10:04:59Z', now)).toBe('04:59')
    expect(remainingTime('2026-10-18T10:00:01Z', now)).toBe('00:01')
    expect(remainingTime('2026-10-18T10:00:00Z', now)).toBeNull()
    expect(remainingTime('garbage', now)).toBeNull()
  })

  it('humanises tool names', () => {
    expect(humanizeTool('find_duplicate_candidates')).toBe('find duplicate candidates')
  })

  it('merges polled messages idempotently and in sequence order', () => {
    const m = (seq: number, content: string): ChatMessage => ({ id: `m${seq}`, seq, role: 'assistant', content, taskId: null, createdAt: '' })
    const merged = mergeMessages([m(1, 'a'), m(3, 'c')], [m(2, 'b'), m(3, 'c2')])
    expect(merged.map((x) => `${x.seq}:${x.content}`)).toEqual(['1:a', '2:b', '3:c2'])
    expect(mergeMessages(merged, merged)).toEqual(merged)
  })
})
