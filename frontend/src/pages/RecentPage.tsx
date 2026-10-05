import { useCallback, useEffect, useState } from 'react'
import { Clock, Eye, FileText, HardDrive, RefreshCw, Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FileTable } from '@/components/drive/FileTable'
import { MetricCard } from '@/components/drive/MetricCard'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetchOptional } from '@/lib/api'
import { formatBytes, formatDate } from '@/lib/format'
import type { FileItem } from '@/data/drive-data'
import { mapFile, type BackendFile } from '@/pages/AllFilesPage'

type StorageSummary = { totalBytes: string; usedBytes: string; availableBytes: string }
type AuditLog = { id: string; action: string; entityType: string; createdAt: string }

function isToday(value: string) {
  const date = new Date(value)
  const now = new Date()
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
}

export function RecentPage() {
  const [files, setFiles] = useState<FileItem[]>([])
  const [recentLogs, setRecentLogs] = useState<AuditLog[]>([])
  const [usedBytes, setUsedBytes] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const [filesData, storage, logsData] = await Promise.all([
        apiFetchOptional<{ files?: BackendFile[]; items?: BackendFile[] }>('/files', { signal }),
        apiFetchOptional<StorageSummary>('/storage/summary', { signal }),
        apiFetchOptional<{ logs?: AuditLog[] }>('/audit-logs', { signal }),
      ])
      if (signal?.aborted) return
      const list = (filesData?.files ?? filesData?.items ?? []).map((file) => ({
        ...mapFile(file),
        openedDate: formatDate(file.createdAt),
      }))
      setFiles(list)
      setUsedBytes(storage?.usedBytes ?? null)
      setRecentLogs((logsData?.logs ?? []).slice(0, 5))
    } catch (err) {
      if (signal?.aborted) return
      setError(err instanceof Error ? err.message : 'Failed to load recent files')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [load])

  const addedToday = files.filter((file) => file.createdAt && isToday(file.createdAt)).length

  return (
    <>
      <PageHeader
        title="Recent"
        description="Latest files by creation time across your connected storage."
        actions={<Button variant="outline" size="sm" onClick={() => load().catch(() => undefined)}><RefreshCw className="h-4 w-4" />Refresh</Button>}
      />

      {error ? (
        <Card className="mt-4 flex flex-col items-start gap-3 border-red-200 bg-red-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold text-red-700">{error}</p>
          <Button variant="outline" size="sm" onClick={() => load().catch(() => undefined)}>Retry</Button>
        </Card>
      ) : null}

      {loading ? (
        <Card className="mt-8 flex flex-col items-center justify-center gap-2 p-12 text-slate-500">
          <RefreshCw className="h-8 w-8 animate-spin text-blue-600" />
          <p className="text-sm">Loading recent files...</p>
        </Card>
      ) : null}

      {!loading && !error ? (
        <>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <MetricCard label="Files Listed" value={String(files.length)} icon={FileText} />
            <MetricCard label="Added Today" value={String(addedToday)} icon={Plus} />
            <MetricCard label="Storage Used" value={usedBytes !== null ? formatBytes(usedBytes) : '--'} icon={HardDrive} />
          </div>

          <Card className="mt-8 p-5">
            <h2 className="flex items-center gap-2 font-extrabold"><Clock className="h-4 w-4 text-blue-600" />Recent Activity</h2>
            <div className="mt-4 grid gap-3">
              {recentLogs.length === 0 ? (
                <p className="text-sm text-slate-500">No recent activity recorded yet.</p>
              ) : recentLogs.map((log) => (
                <div key={log.id} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-blue-600 shadow-sm"><Eye className="h-4 w-4" /></div>
                  <div className="flex-1"><p className="font-semibold capitalize">{log.action.replace(/_/g, ' ')}</p><p className="text-sm text-slate-500">{formatDate(log.createdAt)}</p></div>
                </div>
              ))}
            </div>
          </Card>

          <div className="mt-8">
            {files.length === 0 ? (
              <Card className="p-10 text-center">
                <FileText className="mx-auto h-10 w-10 text-blue-600" />
                <h2 className="mt-4 text-xl font-extrabold">No files yet</h2>
                <p className="mt-2 text-sm text-slate-500">Upload files and they will show up here, newest first.</p>
              </Card>
            ) : (
              <FileTable files={files} mode="recent" />
            )}
          </div>
        </>
      ) : null}
    </>
  )
}
