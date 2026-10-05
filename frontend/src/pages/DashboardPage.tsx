import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Activity, AlertTriangle, Cloud, Database, HardDrive, Inbox, ListChecks, Plug, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { MetricCard } from '@/components/drive/MetricCard'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetchOptional } from '@/lib/api'
import { formatBytes, formatDateTime, percentOf, providerLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

type Capacity = { totalBytes: string; usedBytes: string; availableBytes: string }
type StorageSummary = Capacity
type AccountStatus = { id: string; provider: string; email: string; displayName?: string | null; status: string; storageAccount?: { totalBytes: string | null; usedBytes: string; availableBytes: string | null } | null }
type ProviderAccount = { id?: string; provider?: string; health?: { state?: string } | null }
type JobCounts = { queued: number; active: number; failed: number; completed: number }
type Job = { id: string; status?: string }
type Stats = { fileCount: number; bytes: string }

type DashboardSummary = {
  capacity?: Capacity | null
  accounts?: { total: number; connected: number; degraded: number; unauthorized: number }
  byProvider?: { provider: string; accounts: number; usedBytes?: string | null; totalBytes?: string | null }[]
  files?: { count: number; bytes?: string | null } | null
  health?: { accountId?: string; provider?: string; state?: string }[]
  jobs?: JobCounts
  recentOperations?: { operation?: string; status?: string; createdAt?: string }[]
}

function countJobs(jobs: Job[]): JobCounts {
  const counts: JobCounts = { queued: 0, active: 0, failed: 0, completed: 0 }
  for (const job of jobs) {
    if (job.status === 'queued') counts.queued += 1
    else if (job.status === 'active' || job.status === 'processing' || job.status === 'running') counts.active += 1
    else if (job.status === 'failed' || job.status === 'cancelled') counts.failed += 1
    else if (job.status === 'completed' || job.status === 'succeeded') counts.completed += 1
  }
  return counts
}

function composeFromParts(
  storage: StorageSummary | null,
  accounts: AccountStatus[],
  health: { accountId?: string; provider?: string; state?: string }[],
  jobs: Job[] | null,
  stats: Stats | null,
): DashboardSummary {
  const byProviderMap = new Map<string, { provider: string; accounts: number; usedBytes: number; totalBytes: number }>()
  for (const account of accounts) {
    const entry = byProviderMap.get(account.provider) ?? { provider: account.provider, accounts: 0, usedBytes: 0, totalBytes: 0 }
    entry.accounts += 1
    entry.usedBytes += Number(account.storageAccount?.usedBytes ?? 0)
    entry.totalBytes += Number(account.storageAccount?.totalBytes ?? 0)
    byProviderMap.set(account.provider, entry)
  }

  return {
    capacity: storage,
    accounts: {
      total: accounts.length,
      connected: accounts.filter((account) => account.status === 'connected').length,
      degraded: accounts.filter((account) => account.status === 'degraded' || account.status === 'unauthorized').length,
      unauthorized: accounts.filter((account) => account.status === 'unauthorized').length,
    },
    byProvider: Array.from(byProviderMap.values()).map((entry) => ({
      provider: entry.provider,
      accounts: entry.accounts,
      usedBytes: String(entry.usedBytes),
      totalBytes: String(entry.totalBytes),
    })),
    files: stats ? { count: stats.fileCount, bytes: stats.bytes } : null,
    health,
    jobs: jobs ? countJobs(jobs) : undefined,
    recentOperations: undefined,
  }
}

type AccountStats = AccountStatus

const healthColors: Record<string, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  unauthorized: 'bg-red-500',
  unreachable: 'bg-red-500',
  unknown: 'bg-slate-400',
}

function EmptyBlock({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <Card className="p-8 text-center">
      <Cloud className="mx-auto h-10 w-10 text-blue-600" />
      <h2 className="mt-4 text-xl font-extrabold">{title}</h2>
      <p className="mt-2 text-sm text-slate-500">{description}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </Card>
  )
}

export function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (options: { background?: boolean } = {}) => {
    if (options.background) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const direct = await apiFetchOptional<DashboardSummary>('/dashboard/summary')
      if (direct) {
        setSummary(direct)
        return
      }

      const [storage, accountsRes, providersRes, jobsRes, statsRes] = await Promise.all([
        apiFetchOptional<StorageSummary>('/storage/summary'),
        apiFetchOptional<{ accounts: AccountStats[] }>('/connected-accounts'),
        apiFetchOptional<{ accounts?: ProviderAccount[] } | ProviderAccount[]>('/providers'),
        apiFetchOptional<{ items?: Job[]; jobs?: Job[] }>('/jobs'),
        apiFetchOptional<Stats>('/stats'),
      ])

      const accounts = accountsRes?.accounts ?? []
      const providerList = Array.isArray(providersRes) ? providersRes : (providersRes?.accounts ?? [])
      const health = providerList
        .filter((entry) => entry.health?.state)
        .map((entry) => ({ accountId: entry.id, provider: entry.provider, state: entry.health?.state }))
      const jobs = jobsRes ? (jobsRes.items ?? jobsRes.jobs ?? []) : null

      setSummary(composeFromParts(storage, accounts, health, jobs, statsRes))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  useEffect(() => {
    const onChange = () => {
      load({ background: true }).catch(() => undefined)
    }
    window.addEventListener('9drive:jobs-changed', onChange)
    window.addEventListener('9drive:providers-changed', onChange)
    window.addEventListener('9drive:storage-changed', onChange)
    return () => {
      window.removeEventListener('9drive:jobs-changed', onChange)
      window.removeEventListener('9drive:providers-changed', onChange)
      window.removeEventListener('9drive:storage-changed', onChange)
    }
  }, [load])

  const capacity = summary?.capacity
  const accountStats = summary?.accounts
  const hasAccounts = (accountStats?.total ?? 0) > 0

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Storage capacity, provider health, and background work at a glance."
        actions={<Button variant="outline" onClick={() => load({ background: true }).catch(() => undefined)} disabled={refreshing}><RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />{refreshing ? 'Refreshing...' : 'Refresh'}</Button>}
      />

      {error ? (
        <Card className="mt-6 flex flex-col items-start gap-3 border-red-200 bg-red-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 text-red-700">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <p className="text-sm font-semibold">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => load().catch(() => undefined)}>Retry</Button>
        </Card>
      ) : null}

      {loading && !summary ? (
        <Card className="mt-6 flex flex-col items-center justify-center gap-2 p-12 text-slate-500">
          <RefreshCw className="h-8 w-8 animate-spin text-blue-600" />
          <p className="text-sm">Loading dashboard...</p>
        </Card>
      ) : null}

      {!loading && !error && !summary ? (
        <EmptyBlock title="No dashboard data" description="The dashboard endpoints are unavailable right now." action={<Button onClick={() => load().catch(() => undefined)}>Retry</Button>} />
      ) : null}

      {summary ? (
        <>
          <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
            <MetricCard label="Total Capacity" value={capacity ? formatBytes(capacity.totalBytes) : '--'} icon={HardDrive} />
            <MetricCard label="Used" value={capacity ? formatBytes(capacity.usedBytes) : '--'} icon={Database} />
            <MetricCard label="Available" value={capacity ? formatBytes(capacity.availableBytes) : '--'} icon={Inbox} />
            <MetricCard label="Files" value={summary.files ? String(summary.files.count) : '--'} icon={Activity} />
          </div>

          {!hasAccounts ? (
            <div className="mt-6">
              <EmptyBlock
                title="No storage connected"
                description="Connect Google Drive or S3-compatible storage to start tracking capacity."
                action={<Link to="/providers"><Button><Plug className="h-4 w-4" />Connect storage</Button></Link>}
              />
            </div>
          ) : null}

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <Card className="p-5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h2 className="flex items-center gap-2 text-[16px] font-bold"><Cloud className="h-5 w-5 text-blue-600" />Accounts &amp; Health</h2>
                <Link to="/providers" className="text-xs font-bold text-blue-600 hover:underline">Manage</Link>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl bg-slate-50 p-3 text-center"><p className="text-lg font-extrabold">{accountStats?.total ?? 0}</p><p className="mt-0.5 text-[11px] font-semibold text-slate-500">Total</p></div>
                <div className="rounded-xl bg-emerald-50 p-3 text-center"><p className="text-lg font-extrabold text-emerald-600">{accountStats?.connected ?? 0}</p><p className="mt-0.5 text-[11px] font-semibold text-slate-500">Connected</p></div>
                <div className="rounded-xl bg-amber-50 p-3 text-center"><p className="text-lg font-extrabold text-amber-600">{accountStats?.degraded ?? 0}</p><p className="mt-0.5 text-[11px] font-semibold text-slate-500">Degraded</p></div>
                <div className="rounded-xl bg-red-50 p-3 text-center"><p className="text-lg font-extrabold text-red-600">{accountStats?.unauthorized ?? 0}</p><p className="mt-0.5 text-[11px] font-semibold text-slate-500">Unauthorized</p></div>
              </div>
              <div className="mt-4 grid gap-2">
                {(summary.health ?? []).length === 0 ? (
                  <p className="text-sm text-slate-500">No health checks reported yet.</p>
                ) : (summary.health ?? []).map((entry, index) => {
                  const state = entry.state ?? 'unknown'
                  return (
                    <div key={`${entry.accountId ?? index}`} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                      <span className="truncate font-semibold text-slate-700">{providerLabel(entry.provider)}</span>
                      <span className="flex items-center gap-2 text-xs font-bold capitalize text-slate-600">
                        <span className={cn('h-2 w-2 rounded-full', healthColors[state] ?? 'bg-slate-400')} />
                        {state}
                      </span>
                    </div>
                  )
                })}
              </div>
            </Card>

            <Card className="p-5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h2 className="flex items-center gap-2 text-[16px] font-bold"><Database className="h-5 w-5 text-blue-600" />Capacity by Provider</h2>
              </div>
              <div className="mt-4 grid gap-4">
                {(summary.byProvider ?? []).length === 0 ? (
                  <p className="text-sm text-slate-500">No per-provider data yet.</p>
                ) : (summary.byProvider ?? []).map((entry) => {
                  const percent = percentOf(entry.usedBytes, entry.totalBytes)
                  return (
                    <div key={entry.provider}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-semibold text-slate-700">{providerLabel(entry.provider)} <span className="text-slate-400">· {entry.accounts} account{entry.accounts === 1 ? '' : 's'}</span></span>
                        <span className="font-bold">{Number(entry.totalBytes ?? 0) > 0 ? `${percent}%` : 'Unlimited'}</span>
                      </div>
                      <div className="mt-1.5 h-2 rounded-full bg-slate-100">
                        <div className={cn('h-full rounded-full', percent >= 80 ? 'bg-red-500' : percent >= 50 ? 'bg-amber-400' : 'bg-blue-600')} style={{ width: `${percent}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{formatBytes(entry.usedBytes)} / {Number(entry.totalBytes ?? 0) > 0 ? formatBytes(entry.totalBytes) : 'Unlimited'}</p>
                    </div>
                  )
                })}
              </div>
            </Card>

            <Card className="p-5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h2 className="flex items-center gap-2 text-[16px] font-bold"><ListChecks className="h-5 w-5 text-blue-600" />Active Jobs</h2>
                <Link to="/jobs" className="text-xs font-bold text-blue-600 hover:underline">View all</Link>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl bg-blue-50 p-3 text-center"><p className="text-lg font-extrabold text-blue-600">{summary.jobs?.queued ?? 0}</p><p className="mt-0.5 text-[11px] font-semibold text-slate-500">Queued</p></div>
                <div className="rounded-xl bg-indigo-50 p-3 text-center"><p className="text-lg font-extrabold text-indigo-600">{summary.jobs?.active ?? 0}</p><p className="mt-0.5 text-[11px] font-semibold text-slate-500">Active</p></div>
                <div className="rounded-xl bg-red-50 p-3 text-center"><p className="text-lg font-extrabold text-red-600">{summary.jobs?.failed ?? 0}</p><p className="mt-0.5 text-[11px] font-semibold text-slate-500">Failed</p></div>
                <div className="rounded-xl bg-emerald-50 p-3 text-center"><p className="text-lg font-extrabold text-emerald-600">{summary.jobs?.completed ?? 0}</p><p className="mt-0.5 text-[11px] font-semibold text-slate-500">Completed</p></div>
              </div>
              {!summary.jobs ? <p className="mt-3 text-sm text-slate-500">Job tracking is not available yet.</p> : null}
            </Card>

            <Card className="p-5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h2 className="flex items-center gap-2 text-[16px] font-bold"><Activity className="h-5 w-5 text-blue-600" />Recent Operations</h2>
              </div>
              <div className="mt-3 grid gap-2">
                {(summary.recentOperations ?? []).length === 0 ? (
                  <p className="text-sm text-slate-500">No recent operations recorded.</p>
                ) : (summary.recentOperations ?? []).slice(0, 8).map((operation, index) => (
                  <div key={`${operation.operation ?? 'op'}-${index}`} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                    <span className="truncate font-semibold capitalize text-slate-700">{(operation.operation ?? 'operation').replace(/_/g, ' ')}</span>
                    <span className="flex items-center gap-2 text-xs font-bold capitalize text-slate-600">
                      <span className={cn('h-2 w-2 rounded-full', operation.status === 'succeeded' || operation.status === 'completed' ? 'bg-emerald-500' : operation.status === 'failed' ? 'bg-red-500' : 'bg-slate-400')} />
                      {operation.status ?? 'unknown'}
                      {operation.createdAt ? <span className="font-medium normal-case text-slate-400">{formatDateTime(operation.createdAt)}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      ) : null}
    </>
  )
}
