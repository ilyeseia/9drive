import { useCallback, useEffect, useState } from 'react'
import { FileText, RefreshCw, Star } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FileTable } from '@/components/drive/FileTable'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetchOptional } from '@/lib/api'
import type { FileItem } from '@/data/drive-data'
import { mapFile, type BackendFile } from '@/pages/AllFilesPage'

export function StarredPage() {
  const [files, setFiles] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetchOptional<{ files?: BackendFile[]; items?: BackendFile[] } | BackendFile[]>('/files/starred', { signal })
      if (signal?.aborted) return
      const list = Array.isArray(data) ? data : (data?.files ?? data?.items ?? [])
      setFiles(list.map(mapFile))
    } catch (err) {
      if (signal?.aborted) return
      setError(err instanceof Error ? err.message : 'Failed to load starred files')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [load])

  return (
    <>
      <PageHeader
        title="Starred"
        description="Pinned files for quick access."
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
          <p className="text-sm">Loading starred files...</p>
        </Card>
      ) : null}

      {!loading && !error && files.length === 0 ? (
        <Card className="mt-8 p-10 text-center">
          <Star className="mx-auto h-10 w-10 text-yellow-400" />
          <h2 className="mt-4 text-xl font-extrabold">No starred files yet</h2>
          <p className="mt-2 text-sm text-slate-500">Star files to pin them here. This list is empty until file pinning becomes available.</p>
        </Card>
      ) : null}

      {!loading && !error && files.length > 0 ? (
        <>
          <Card className="mt-8 flex items-center gap-3 p-4 text-sm text-slate-600">
            <FileText className="h-4 w-4 text-blue-600" />
            <span>{files.length} starred file{files.length === 1 ? '' : 's'}.</span>
          </Card>
          <FileTable files={files} mode="starred" />
        </>
      ) : null}
    </>
  )
}
