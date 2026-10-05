import { markProgress } from '../queues/mirror.js'

const THROTTLE_MS = 500

interface ProgressState {
  lastWriteAt: number
  latest: number
  written: number
  timer: NodeJS.Timeout | null
}

const states = new Map<string, ProgressState>()

function clamp(pct: number): number {
  if (!Number.isFinite(pct)) return 0
  return Math.max(0, Math.min(100, Math.round(pct)))
}

function flushNow(rowId: string, state: ProgressState): void {
  state.lastWriteAt = Date.now()
  state.written = state.latest
  void markProgress(rowId, state.latest)
}

export function reportProgress(rowId: string, pct: number): void {
  const value = clamp(pct)
  let state = states.get(rowId)
  if (!state) {
    state = { lastWriteAt: 0, latest: value, written: -1, timer: null }
    states.set(rowId, state)
  }
  state.latest = value
  const now = Date.now()
  const wait = THROTTLE_MS - (now - state.lastWriteAt)
  if (wait <= 0) {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    flushNow(rowId, state)
    return
  }
  if (!state.timer) {
    state.timer = setTimeout(() => {
      const current = states.get(rowId)
      if (!current) return
      current.timer = null
      flushNow(rowId, current)
    }, wait)
    state.timer.unref?.()
  }
}

export function flushProgress(rowId: string): void {
  const state = states.get(rowId)
  if (!state) return
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  if (state.written !== state.latest) flushNow(rowId, state)
  states.delete(rowId)
}

export function flushAllProgress(): void {
  for (const rowId of [...states.keys()]) flushProgress(rowId)
}
