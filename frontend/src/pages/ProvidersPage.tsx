import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, Cloud, Database, HardDrive, Link2, Plug, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch, apiFetchOptional, isAllowedRedirectUrl } from '@/lib/api'
import { formatBytes, formatDateTime, percentOf, providerLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

type StorageQuota = { totalBytes?: string | null; usedBytes?: string | null; availableBytes?: string | null }
type ProviderEntry = {
  id: string
  provider?: string
  displayName?: string | null
  email?: string
  status?: string
  capabilities?: string[]
  quota?: StorageQuota | null
  health?: { state?: string; checkedAt?: string } | null
  lastSyncedAt?: string | null
}
type ConnectedAccount = {
  id: string
  provider: string
  email: string
  displayName?: string | null
  status: string
  storageAccount?: (StorageQuota & { lastSyncedAt?: string | null }) | null
}
type ProviderRow = {
  id: string
  provider: string
  email: string
  displayName?: string | null
  status: string
  capabilities: string[]
  usedBytes: string | null
  totalBytes: string | null
  availableBytes: string | null
  healthState: string | null
  healthCheckedAt: string | null
  lastSyncedAt: string | null
}

function fromProviderEntry(entry: ProviderEntry): ProviderRow {
  return {
    id: entry.id,
    provider: entry.provider ?? 'google_drive',
    email: entry.email ?? '',
    displayName: entry.displayName ?? null,
    status: entry.status ?? 'connected',
    capabilities: entry.capabilities ?? [],
    usedBytes: entry.quota?.usedBytes ?? null,
    totalBytes: entry.quota?.totalBytes ?? null,
    availableBytes: entry.quota?.availableBytes ?? null,
    healthState: entry.health?.state ?? null,
    healthCheckedAt: entry.health?.checkedAt ?? null,
    lastSyncedAt: entry.lastSyncedAt ?? null,
  }
}

function fromAccount(account: ConnectedAccount): ProviderRow {
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    displayName: account.displayName ?? null,
    status: account.status,
    capabilities: [],
    usedBytes: account.storageAccount?.usedBytes ?? null,
    totalBytes: account.storageAccount?.totalBytes ?? null,
    availableBytes: account.storageAccount?.availableBytes ?? null,
    healthState: account.status === 'connected' ? 'healthy' : account.status === 'unauthorized' ? 'unauthorized' : null,
    healthCheckedAt: null,
    lastSyncedAt: account.storageAccount?.lastSyncedAt ?? null,
  }
}

const statusStyles: Record<string, string> = {
  connected: 'bg-emerald-50 text-emerald-700',
  degraded: 'bg-amber-50 text-amber-700',
  unauthorized: 'bg-red-50 text-red-700',
  disconnected: 'bg-slate-100 text-slate-500',
}

const healthDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  unauthorized: 'bg-red-500',
  unreachable: 'bg-red-500',
}

export function ProvidersPage() {
  const [rows, setRows] = useState<ProviderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const [connectingGoogle, setConnectingGoogle] = useState(false)
  const [connectingDropbox, setConnectingDropbox] = useState(false)
  const [s3Open, setS3Open] = useState(false)
  const [connectingS3, setConnectingS3] = useState(false)
  const [s3Form, setS3Form] = useState({ name: '', bucket: '', region: 'us-east-1', endpoint: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false, quotaBytes: '' })

  const [teraOpen, setTeraOpen] = useState(false)
  const [connectingTera, setConnectingTera] = useState(false)
  const [teraForm, setTeraForm] = useState({ name: '', cookie: '' })

  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<ProviderRow | null>(null)
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const fromProviders = await apiFetchOptional<ProviderEntry[] | { providers?: ProviderEntry[]; accounts?: ProviderEntry[]; items?: ProviderEntry[] }>('/providers', { signal })
      if (fromProviders) {
        const list = Array.isArray(fromProviders) ? fromProviders : (fromProviders.providers ?? fromProviders.accounts ?? fromProviders.items ?? [])
        setRows(list.map(fromProviderEntry))
        return
      }
      const data = await apiFetchOptional<{ accounts: ConnectedAccount[] }>('/connected-accounts', { signal })
      setRows((data?.accounts ?? []).map(fromAccount))
    } catch (err) {
      if (signal?.aborted) return
      setError(err instanceof Error ? err.message : 'Failed to load storage providers')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).catch(() => undefined)
    const onStorageChanged = () => {
      load().catch(() => undefined)
    }
    window.addEventListener('9drive:storage-changed', onStorageChanged)
    return () => {
      controller.abort()
      window.removeEventListener('9drive:storage-changed', onStorageChanged)
    }
  }, [load])

  function notifyChanged() {
    window.dispatchEvent(new Event('9drive:storage-changed'))
    window.dispatchEvent(new Event('9drive:providers-changed'))
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.data?.type !== 'GOOGLE_CONNECTED') return
      setMessage(event.data.status === 'success' ? 'Google Drive connected.' : 'Google Drive connection failed.')
      load().then(notifyChanged).catch(() => undefined)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [load])

  async function connectDrive() {
    setConnectingGoogle(true)
    setMessage('')
    const popup = window.open('', 'google-drive-connect', 'width=540,height=720')
    if (popup) {
      popup.document.write('<html><head><title>Connecting...</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;color:#64748b;}</style></head><body><div style="text-align:center;"><h2>Connecting to Google...</h2><p>Please wait while we redirect you.</p></div></body></html>')
    }
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/google/connect-url')
      if (!isAllowedRedirectUrl(data.url)) {
        throw new Error('Server returned an unexpected redirect URL.')
      }
      if (popup) {
        popup.location.href = data.url
      } else {
        window.location.href = data.url
      }
    } catch (error) {
      if (popup) popup.close()
      setMessage(error instanceof Error ? error.message : 'Failed to start Google Drive connection')
    } finally {
      setConnectingGoogle(false)
    }
  }

  async function connectDropbox() {
    setConnectingDropbox(true)
    setMessage('')
    const popup = window.open('', 'dropbox-connect', 'width=540,height=720')
    if (popup) {
      popup.document.write('<html><head><title>Connecting...</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;color:#64748b;}</style></head><body><div style="text-align:center;"><h2>Connecting to Dropbox...</h2><p>Please wait while we redirect you.</p></div></body></html>')
    }
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/dropbox/connect-url')
      if (!isAllowedRedirectUrl(data.url)) {
        throw new Error('Server returned an unexpected redirect URL.')
      }
      if (popup) {
        popup.location.href = data.url
      } else {
        window.location.href = data.url
      }

      const startedAt = Date.now()
      const timer = window.setInterval(() => {
        if (popup?.closed || Date.now() - startedAt > 120_000) {
          window.clearInterval(timer)
          setConnectingDropbox(false)
          load().then(notifyChanged).catch(() => undefined)
          return
        }
        apiFetchOptional<{ accounts: { provider: string; status: string }[] }>('/connected-accounts')
          .then((accounts) => {
            const linked = accounts?.accounts.some((account) => account.provider === 'dropbox' && account.status === 'connected')
            if (!linked) return
            window.clearInterval(timer)
            popup?.close()
            setConnectingDropbox(false)
            setMessage('Dropbox connected.')
            load().then(notifyChanged).catch(() => undefined)
          })
          .catch(() => undefined)
      }, 2000)
    } catch (error) {
      if (popup) popup.close()
      setConnectingDropbox(false)
      setMessage(error instanceof Error ? error.message : 'Failed to start Dropbox connection')
    }
  }

  async function connectS3(event: FormEvent) {
    event.preventDefault()
    setConnectingS3(true)
    setMessage('')
    try {
      await apiFetch('/connected-accounts/s3', {
        method: 'POST',
        body: JSON.stringify({ ...s3Form, endpoint: s3Form.endpoint || undefined, quotaBytes: s3Form.quotaBytes || null }),
      })
      setS3Open(false)
      setS3Form({ name: '', bucket: '', region: 'us-east-1', endpoint: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: false, quotaBytes: '' })
      setMessage('S3 storage connected.')
      await load()
      notifyChanged()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to connect S3 storage')
    } finally {
      setConnectingS3(false)
    }
  }

  async function connectTeraBox(event: FormEvent) {
    event.preventDefault()
    setConnectingTera(true)
    setMessage('')
    try {
      await apiFetch('/providers/terabox/accounts', {
        method: 'POST',
        body: JSON.stringify({ apiKey: teraForm.cookie.trim(), name: teraForm.name.trim() || undefined }),
      })
      setTeraOpen(false)
      setTeraForm({ name: '', cookie: '' })
      setMessage('TeraBox connected.')
      await load()
      notifyChanged()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to connect TeraBox')
    } finally {
      setConnectingTera(false)
    }
  }

  async function syncQuota(id: string) {
    setSyncingId(id)
    setMessage('')
    try {
      await apiFetch(`/connected-accounts/${id}/sync-quota`, { method: 'POST' })
      setMessage('Quota sync requested.')
      await load()
      notifyChanged()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to sync quota')
    } finally {
      setSyncingId(null)
    }
  }

  async function checkHealth(id: string) {
    setCheckingId(id)
    setMessage('')
    try {
      const result = await apiFetch<{ state?: string; checkedAt?: string }>(`/providers/accounts/${id}/health`, { method: 'POST' })
      setRows((current) => current.map((row) => (row.id === id ? { ...row, healthState: result.state ?? row.healthState, healthCheckedAt: result.checkedAt ?? row.healthCheckedAt } : row)))
      setMessage(`Health check: ${result.state ?? 'done'}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Health check is not available yet')
    } finally {
      setCheckingId(null)
    }
  }

  async function disconnect() {
    if (!disconnectTarget) return
    setDisconnectingId(disconnectTarget.id)
    setMessage('')
    try {
      await apiFetch(`/connected-accounts/${disconnectTarget.id}`, { method: 'DELETE' })
      setDisconnectTarget(null)
      setMessage('Storage account disconnected.')
      await load()
      notifyChanged()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to disconnect storage account')
    } finally {
      setDisconnectingId(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Providers"
        description="Connect and manage storage accounts: Google Drive, S3-compatible endpoints, TeraBox, quota, and health."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setS3Open(true)}><Database className="h-4 w-4" />Connect S3</Button>
            <Button variant="outline" size="sm" onClick={() => setTeraOpen(true)}><HardDrive className="h-4 w-4" />Connect TeraBox</Button>
            <Button variant="outline" size="sm" onClick={connectDropbox} disabled={connectingDropbox}><Cloud className="h-4 w-4" />{connectingDropbox ? 'Connecting...' : 'Connect Dropbox'}</Button>
            <Button size="sm" onClick={connectDrive} disabled={connectingGoogle}><Link2 className="h-4 w-4" />{connectingGoogle ? 'Connecting...' : 'Connect Drive'}</Button>
          </>
        }
      />

      {message ? <p className="mt-4 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p> : null}

      {error ? (
        <Card className="mt-4 flex flex-col items-start gap-3 border-red-200 bg-red-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 text-red-700">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <p className="text-sm font-semibold">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => load().catch(() => undefined)}>Retry</Button>
        </Card>
      ) : null}

      {loading ? (
        <Card className="mt-6 flex flex-col items-center justify-center gap-2 p-12 text-slate-500">
          <RefreshCw className="h-8 w-8 animate-spin text-blue-600" />
          <p className="text-sm">Loading providers...</p>
        </Card>
      ) : null}

      {!loading && !error && rows.length === 0 ? (
        <Card className="mt-6 p-10 text-center">
          <Plug className="mx-auto h-10 w-10 text-blue-600" />
          <h2 className="mt-4 text-xl font-extrabold">No storage connected</h2>
          <p className="mt-2 text-sm text-slate-500">Connect a Google Drive account or an S3-compatible bucket to start storing files.</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <Button onClick={connectDrive} disabled={connectingGoogle}><Link2 className="h-4 w-4" />{connectingGoogle ? 'Opening...' : 'Connect Drive'}</Button>
            <Button variant="outline" onClick={() => setTeraOpen(true)}><HardDrive className="h-4 w-4" />Connect TeraBox</Button>
            <Button variant="outline" onClick={connectDropbox} disabled={connectingDropbox}><Cloud className="h-4 w-4" />{connectingDropbox ? 'Opening...' : 'Connect Dropbox'}</Button>
            <Button variant="outline" onClick={() => setS3Open(true)}><Database className="h-4 w-4" />Connect S3</Button>
          </div>
        </Card>
      ) : null}

      {!loading && rows.length > 0 ? (
        <div className="mt-6 grid gap-4">
          {rows.map((row) => {
            const percent = percentOf(row.usedBytes, row.totalBytes)
            const unlimited = row.provider === 's3' && row.totalBytes === null
            const quotaKnown = row.usedBytes !== null
            const statusClass = statusStyles[row.status] ?? 'bg-slate-100 text-slate-600'
            const healthColor = row.healthState ? (healthDot[row.healthState] ?? 'bg-slate-400') : 'bg-slate-300'
            return (
              <Card key={row.id} className="p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                      <Cloud className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-extrabold text-slate-900">{row.displayName || row.email || row.id}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span>{providerLabel(row.provider)}</span>
                        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold capitalize', statusClass)}>{row.status}</span>
                        <span className="flex items-center gap-1 capitalize"><span className={cn('h-2 w-2 rounded-full', healthColor)} />{row.healthState ?? 'no health data'}</span>
                      </p>
                      {row.capabilities.length > 0 ? (
                        <p className="mt-1.5 flex flex-wrap gap-1">
                          {row.capabilities.slice(0, 6).map((cap) => (
                            <span key={cap} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">{cap}</span>
                          ))}
                          {row.capabilities.length > 6 ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">+{row.capabilities.length - 6} more</span> : null}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:flex">
                    <Button size="sm" variant="outline" onClick={() => syncQuota(row.id)} disabled={syncingId === row.id}><RefreshCw className={syncingId === row.id ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />Sync</Button>
                    <Button size="sm" variant="outline" onClick={() => checkHealth(row.id)} disabled={checkingId === row.id}><AlertTriangle className={checkingId === row.id ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />Health</Button>
                    <Button size="sm" variant="danger" onClick={() => setDisconnectTarget(row)}><Trash2 className="h-4 w-4" />Disconnect</Button>
                  </div>
                </div>

                <div className="mt-4">
                  {!quotaKnown ? (
                    <p className="text-xs text-slate-400">No quota information yet.</p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
                        <span>{formatBytes(row.usedBytes)} used</span>
                        <span>{unlimited ? 'Unlimited bucket' : `${percent}% of ${formatBytes(row.totalBytes)}`}</span>
                      </div>
                      <div className="mt-1.5 h-2 rounded-full bg-slate-100">
                        <div className={cn('h-full rounded-full', percent >= 80 ? 'bg-red-500' : percent >= 50 ? 'bg-amber-400' : 'bg-blue-600')} style={{ width: `${unlimited ? Math.min(percent, 10) : percent}%` }} />
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                        <span>Available: {unlimited ? 'Unlimited' : formatBytes(row.availableBytes)}</span>
                        {row.lastSyncedAt ? <span>Last synced: {formatDateTime(row.lastSyncedAt)}</span> : null}
                        {row.healthCheckedAt ? <span>Health checked: {formatDateTime(row.healthCheckedAt)}</span> : null}
                      </div>
                    </>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      ) : null}

      <DummyModal open={s3Open} title="Connect S3 Storage" description="Use any S3-compatible provider with custom endpoint support." onClose={() => setS3Open(false)}>
        <form className="grid gap-4" onSubmit={connectS3}>
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Display name" value={s3Form.name} onChange={(event) => setS3Form({ ...s3Form, name: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Bucket" value={s3Form.bucket} onChange={(event) => setS3Form({ ...s3Form, bucket: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Region" value={s3Form.region} onChange={(event) => setS3Form({ ...s3Form, region: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Endpoint URL (optional)" value={s3Form.endpoint} onChange={(event) => setS3Form({ ...s3Form, endpoint: event.target.value })} />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Access key ID" value={s3Form.accessKeyId} onChange={(event) => setS3Form({ ...s3Form, accessKeyId: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Secret access key" type="password" value={s3Form.secretAccessKey} onChange={(event) => setS3Form({ ...s3Form, secretAccessKey: event.target.value })} required />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Quota bytes (optional)" inputMode="numeric" value={s3Form.quotaBytes} onChange={(event) => setS3Form({ ...s3Form, quotaBytes: event.target.value })} />
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={s3Form.forcePathStyle} onChange={(event) => setS3Form({ ...s3Form, forcePathStyle: event.target.checked })} />Force path style</label>
          <div className="grid gap-3 sm:flex sm:justify-end">
            <Button variant="outline" type="button" onClick={() => setS3Open(false)} disabled={connectingS3}>Cancel</Button>
            <Button type="submit" disabled={connectingS3}>{connectingS3 ? 'Connecting...' : 'Connect S3'}</Button>
          </div>
        </form>
      </DummyModal>

      <DummyModal open={teraOpen} title="Connect TeraBox" description="Paste your TeraBox session cookie to link this storage account." onClose={() => setTeraOpen(false)}>
        <form className="grid gap-4" onSubmit={connectTeraBox}>
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="Display name (optional)" value={teraForm.name} onChange={(event) => setTeraForm({ ...teraForm, name: event.target.value })} />
          <input className="h-11 rounded-xl border border-slate-200 px-3 text-sm" placeholder="ndus cookie value" type="password" autoComplete="off" value={teraForm.cookie} onChange={(event) => setTeraForm({ ...teraForm, cookie: event.target.value })} required />
          <p className="text-xs text-slate-500">
            Sign in at terabox.com, open DevTools (F12) → Application → Cookies → www.terabox.com, and copy the <span className="font-bold">ndus</span> cookie. Paste either the value alone or the full <span className="font-bold">ndus=…</span> pair.
          </p>
          <div className="grid gap-3 sm:flex sm:justify-end">
            <Button variant="outline" type="button" onClick={() => setTeraOpen(false)} disabled={connectingTera}>Cancel</Button>
            <Button type="submit" disabled={connectingTera}>{connectingTera ? 'Connecting...' : 'Connect TeraBox'}</Button>
          </div>
        </form>
      </DummyModal>

      <DummyModal open={Boolean(disconnectTarget)} title="Disconnect storage?" description="This will remove this storage account from 9Drive. Existing file records for this account may no longer be usable." onClose={() => setDisconnectTarget(null)}>
        <div className="grid gap-4">
          <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
            <p className="font-semibold text-slate-950">{disconnectTarget?.displayName || disconnectTarget?.email}</p>
            <p className="mt-1">Used storage: {formatBytes(disconnectTarget?.usedBytes)}</p>
          </div>
          <div className="grid gap-3 sm:flex sm:justify-end">
            <Button variant="outline" onClick={() => setDisconnectTarget(null)} disabled={Boolean(disconnectingId)}>Cancel</Button>
            <Button variant="danger" onClick={disconnect} disabled={Boolean(disconnectingId)}><Trash2 className="h-4 w-4" />{disconnectingId ? 'Disconnecting...' : 'Disconnect'}</Button>
          </div>
        </div>
      </DummyModal>
    </>
  )
}
