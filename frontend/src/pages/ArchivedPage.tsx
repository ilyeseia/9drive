import { useCallback, useEffect, useState } from 'react'
import { Archive, RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FileTable } from '@/components/drive/FileTable'
import { PageHeader } from '@/components/drive/PageHeader'
import { apiFetchOptional } from '@/lib/api'
import type { FileItem } from '@/data/drive-data'
import { mapFile, type BackendFile } from '@/pages/AllFilesPage'

export function ArchivedPage() {
  const [files, setFiles] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetchOptional<{ files?: BackendFile[]; items?: BackendFile[] } | BackendFile[]>('/files/archived', { signal })
      if (signal?.aborted) return
      const list = Array.isArray(data) ? data : (data?.files ?? data?.items ?? [])
      setFiles(list.map(mapFile))
    } catch (err) {
      if (signal?.aborted) return
      setError(err instanceof Error ? err.message : 'Failed to load archived files')
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
        title="Archived"
        description="Older files kept out of the active workspace."
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
          <p className="text-sm">Loading archived files...</p>
        </Card>
      ) : null}

      {!loading && !error && files.length === 0 ? (
        <Card className="mt-8 p-10 text-center">
          <Archive className="mx-auto h-10 w-10 text-orange-500" />
          <h2 className="mt-4 text-xl font-extrabold">Nothing archived</h2>
          <p className="mt-2 text-sm text-slate-500">Archived files will appear here. Archiving is not available yet — use the Recycle Bin for removed files.</p>
        </Card>
      ) : null}

      {!loading && !error && files.length > 0 ? (
        <>
          <Card className="mt-8 border-orange-200 bg-orange-50 p-4 text-sm text-orange-700">
            Archived files stay available and do not count as active workspace clutter.
          </Card>
          <FileTable files={files} mode="archived" />
        </>
      ) : null}
    </>
  )
}
