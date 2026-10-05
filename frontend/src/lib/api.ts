import { clearAuthSession, getAccessToken, getRefreshToken, setAccessToken } from '@/lib/auth'

// Legacy re-exports — the implementations live in @/lib/format now.
export { formatBytes, formatDate } from '@/lib/format'

const isProd = import.meta.env.PROD
const rawApiUrl = import.meta.env.VITE_API_URL
export const API_URL = (rawApiUrl && rawApiUrl !== 'http://localhost:4000')
  ? rawApiUrl
  : (isProd ? '/api' : 'http://localhost:4000')


type ApiOptions = RequestInit & { skipAuth?: boolean; retry?: boolean }

export class ApiError extends Error {
  status: number
  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function refreshAccessToken() {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!response.ok) return false
  const data = await response.json() as { accessToken: string; refreshToken?: string }
  setAccessToken(data.accessToken)
  if (data.refreshToken) {
    localStorage.setItem('9drive.refreshToken', data.refreshToken)
  }
  return true
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  const token = getAccessToken()
  if (!options.skipAuth && token) headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const response = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (response.status === 401 && options.retry !== false && !options.skipAuth && await refreshAccessToken()) {
    return apiFetch<T>(path, { ...options, retry: false })
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    if (response.status === 401) clearAuthSession()
    throw new ApiError(error.message ?? 'Request failed', response.status, error.code)
  }

  return response.json() as Promise<T>
}

/**
 * Like apiFetch, but returns `null` when the endpoint does not exist yet (404).
 * Used by pages that consume endpoints which may not be deployed during a refactor.
 */
export async function apiFetchOptional<T>(path: string, options: ApiOptions = {}): Promise<T | null> {
  try {
    return await apiFetch<T>(path, options)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

const DEFAULT_REDIRECT_HOSTS = ['accounts.google.com']

function allowedRedirectHosts(): Set<string> {
  const raw = import.meta.env.VITE_ALLOWED_REDIRECT_HOSTS
  const extra = typeof raw === 'string'
    ? raw.split(/[\s,]+/).map((host) => host.trim().toLowerCase()).filter(Boolean)
    : []
  return new Set([...DEFAULT_REDIRECT_HOSTS, ...extra])
}

/**
 * Open-redirect guard (security-contract.md §14): a URL returned by the API may
 * only be navigated to when its host is in the configured allow-list.
 */
export function isAllowedRedirectUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false
  let parsed: URL
  try {
    parsed = new URL(url, window.location.origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.username || parsed.password) return false
  if (parsed.origin === window.location.origin) return true
  return allowedRedirectHosts().has(parsed.hostname.toLowerCase())
}
