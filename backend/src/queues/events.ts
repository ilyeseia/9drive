type EventBusLike = {
  emit: (name: string, payload: Record<string, unknown>) => void
}

let cached: EventBusLike | null | undefined

async function loadEventBus(): Promise<EventBusLike | null> {
  if (cached !== undefined) return cached
  try {
    const specifier: string = '../events/bus.js'
    const loaded: unknown = await import(specifier)
    const candidate = loaded as { events?: EventBusLike; default?: EventBusLike }
    cached = candidate.events ?? candidate.default ?? null
  } catch {
    cached = null
  }
  return cached
}

export function emitJobEvent(name: string, payload: Record<string, unknown>): void {
  void loadEventBus()
    .then((bus) => {
      if (!bus) return
      try {
        bus.emit(name, payload)
      } catch {
        return
      }
    })
    .catch(() => undefined)
}
