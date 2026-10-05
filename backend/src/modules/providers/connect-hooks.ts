/**
 * Per-provider OAuth connect-callback hooks.
 *
 * provider-contract §1 keeps provider-specific code inside `providers/<id>/`,
 * but that tree is coordinator-owned in Wave 5; this registry is the single
 * sanctioned extension point until the coordinator moves each registration
 * into its adapter (see REQUESTS_TO_COORDINATOR: pcloud EU hostname hook).
 * Hooks only derive metadata persisted on ConnectedAccount - they never talk
 * to the network and their output is reduced to JSON scalar values.
 */

export type ConnectCallbackMetadata = Record<string, string | number | boolean>

export type ConnectCallbackHook = (query: Record<string, unknown>) => ConnectCallbackMetadata | null

const hooks = new Map<string, ConnectCallbackHook>()

export function registerConnectCallbackHook(provider: string, hook: ConnectCallbackHook): void {
  hooks.set(provider, hook)
}

function scalarRecord(value: unknown): ConnectCallbackMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record: ConnectCallbackMetadata = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') record[key] = entry
  }
  return record
}

export function applyConnectCallbackHooks(provider: string, query: Record<string, unknown>): ConnectCallbackMetadata {
  const hook = hooks.get(provider)
  if (!hook) return {}
  return scalarRecord(hook(query)) ?? {}
}

const PCLOUD_HOSTNAMES = new Set(['api.pcloud.com', 'eapi.pcloud.com'])

registerConnectCallbackHook('pcloud', (query) => {
  const hostname = typeof query.hostname === 'string' ? query.hostname.trim().toLowerCase() : ''
  if (!PCLOUD_HOSTNAMES.has(hostname)) return null
  return { apiBaseUrl: `https://${hostname}`, tokenUrl: `https://${hostname}/oauth2_token` }
})
