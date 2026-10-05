import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Inbox, ListChecks, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetch, apiFetchOptional } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

type Job = {
  id: string
  type?: string
  status?: string
  provider?: string
  progress?: number
  attempts?: number
  error?: string | null
  createdAt?: string
  updatedAt?: string
}

const statusFilterOptions = [
  { value: '', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
]

const statusBadge: Record<string, string> = {
  queued: 'bg-blue-50 text-blue-700',
  active: 'bg-indigo-50 text-indigo-700',
  processing: 'bg-indigo-50 text-indigo-700',
  running: 'bg-indigo-50 text-indigo-700',
  completed: 'bg-emerald-50 text-emerald-700',
  succeeded: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500',
}

const POLL_INTERVAL_MS = 5000

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sourceAvailable, setSourceAvailable] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback(async (options: { background?: boolean } = {}) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    if (!options.background) setLoading(true)
    try {
      const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ''
      const data = await apiFetchOptional<{ items?: Job[]; jobs?: Job[] } | Job[]>(`/jobs${query}`, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (!data) {
        setJobs([])
        setSourceAvailable(false)
        return
      }
      const list = Array.isArray(data) ? data : (data.items ?? data.jobs ?? [])
      setJobs(list)
      setSourceAvailable(true)
      setError('')
    } catch (err) {
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    load().catch(() => undefined)
  }, [load])

  useEffect(() => {
    let timer: number | undefined

    const tick = () => {
      if (document.visibilityState === 'visible') {
        load({ background: true }).catch(() => undefined)
      }
      timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load({ background: true }).catch(() => undefined)
      }
    }

    timer = window.setTimeout(tick, POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      controllerRef.current?.abort()
    }
  }, [load])

  async function runAction(action: 'retry' | 'cancel' | 'delete', job: Job) {
    setBusyId(job.id)
    setMessage('')
    try {
      if (action === 'delete') {
        await apiFetch(`/jobs/${job.id}`, { method: 'DELETE' })
        setMessage(`Removed job ${job.id}.`)
      } else {
        await apiFetch(`/jobs/${job.id}/${action}`, { method: 'POST' })
        setMessage(action === 'retry' ? `Retrying job ${job.id}.` : `Cancelling job ${job.id}.`)
      }
      window.dispatchEvent(new Event('9drive:jobs-changed'))
      await load({ background: true })
    } catch (err) {
      setMessage(err instanceof Error ? err.message : `Failed to ${action} job`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Background uploads, syncs, and maintenance tasks with live status."
        actions={
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 focus:outline-none"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label="Filter jobs by status"
            >
              {statusFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <Button variant="outline" size="sm" onClick={() => load().catch(() => undefined)}><RefreshCw className="h-4 w-4" />Refresh</Button>
          </div>
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
          <p className="text-sm">Loading jobs...</p>
        </Card>
      ) : null}

      {!loading && !error && !sourceAvailable ? (
        <Card className="mt-6 p-10 text-center">
          <Inbox className="mx-auto h-10 w-10 text-blue-600" />
          <h2 className="mt-4 text-xl font-extrabold">Job queue is not available yet</h2>
          <p className="mt-2 text-sm text-slate-500">The jobs API is not enabled on this backend. Uploads still run in real time and will appear here once the job service is mounted.</p>
          <div className="mt-5 flex justify-center">
            <Button variant="outline" onClick={() => load().catch(() => undefined)}><RefreshCw className="h-4 w-4" />Check again</Button>
          </div>
        </Card>
      ) : null}

      {!loading && sourceAvailable && jobs.length === 0 ? (
        <Card className="mt-6 p-10 text-center">
          <ListChecks className="mx-auto h-10 w-10 text-blue-600" />
          <h2 className="mt-4 text-xl font-extrabold">No jobs found</h2>
          <p className="mt-2 text-sm text-slate-500">{statusFilter ? `No jobs with status "${statusFilter}".` : 'Background jobs will show up here as you upload and sync files.'}</p>
        </Card>
      ) : null}

      {!loading && jobs.length > 0 ? (
        <div className="mt-6 grid gap-3">
          {jobs.map((job) => {
            const status = job.status ?? 'unknown'
            const badge = statusBadge[status] ?? 'bg-slate-100 text-slate-600'
            const canRetry = status === 'failed' || status === 'cancelled'
            const canCancel = status === 'queued' || status === 'active' || status === 'processing' || status === 'running'
            const canDelete = status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'succeeded'
            const busy = busyId === job.id
            return (
              <Card key={job.id} className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-extrabold text-slate-900">{job.type ?? 'job'}</p>
                      <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold capitalize', badge)}>{status}</span>
                      {job.provider ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{job.provider}</span> : null}
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-400">#{job.id}{job.createdAt ? ` · created ${formatDateTime(job.createdAt)}` : ''}{job.updatedAt ? ` · updated ${formatDateTime(job.updatedAt)}` : ''}</p>
                    {job.error ? <p className="mt-1 break-words text-xs font-semibold text-red-600">{job.error}</p> : null}
                  </div>
                  <div className="flex items-center gap-3">
                    {typeof job.progress === 'number' && job.progress >= 0 ? (
                      <div className="hidden w-32 sm:block">
                        <div className="h-2 rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, job.progress)}%` }} />
                        </div>
                        <p className="mt-1 text-right text-[11px] font-bold text-slate-500">{Math.min(100, job.progress)}%</p>
                      </div>
                    ) : null}
                    <div className="grid grid-cols-3 gap-2 sm:flex">
                      <Button size="sm" variant="outline" disabled={!canRetry || busy} onClick={() => runAction('retry', job)}><RotateCcw className="h-4 w-4" />Retry</Button>
                      <Button size="sm" variant="outline" disabled={!canCancel || busy} onClick={() => runAction('cancel', job)}><Square className="h-4 w-4" />Cancel</Button>
                      <Button size="sm" variant="danger" disabled={!canDelete || busy} onClick={() => runAction('delete', job)}><Trash2 className="h-4 w-4" />Delete</Button>
                    </div>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      ) : null}
    </>
  )
}
