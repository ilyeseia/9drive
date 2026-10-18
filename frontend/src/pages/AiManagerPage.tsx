import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw, ShieldCheck, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ApiError } from '@/lib/api'
import { STATUS_KEYS, assistantAdminApi, errorKeyFor, isActiveStatus, type AdminOverview, type AdminTestResult } from '@/lib/assistant'
import { useLocale } from '@/lib/i18n'

const fmt = (n: number) => new Intl.NumberFormat().format(n)

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:bg-slate-900">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-extrabold">{value}</p>
    </div>
  )
}

export function AiManagerPage() {
  const { t, dir } = useLocale()
  const [data, setData] = useState<AdminOverview | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AdminTestResult | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await assistantAdminApi.overview())
      setError(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true)
      else setError(t(errorKeyFor(e)))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await assistantAdminApi.test())
    } catch (e) {
      setError(t(errorKeyFor(e)))
    } finally {
      setTesting(false)
    }
  }

  async function stop(taskId: string) {
    setStopping(taskId)
    try {
      await assistantAdminApi.cancelTask(taskId)
      await load()
    } catch (e) {
      setError(t(errorKeyFor(e)))
    } finally {
      setStopping(null)
    }
  }

  if (forbidden) {
    return (
      <div dir={dir} className="p-6">
        <Card className="border-amber-200 bg-amber-50 p-4" role="alert">
          <p className="flex items-center gap-2 text-sm font-extrabold text-amber-800"><AlertTriangle className="h-5 w-5" aria-hidden="true" />{t('mgrForbidden')}</p>
        </Card>
      </div>
    )
  }

  const cfg = data?.config
  return (
    <div dir={dir} className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-extrabold"><ShieldCheck className="h-5 w-5" aria-hidden="true" />{t('mgrTitle')}</h1>
          <p className="text-xs text-slate-500">{t('mgrSubtitle')}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          <span className="ms-2">{t('mgrRefresh')}</span>
        </Button>
      </div>

      {error ? <Card className="border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</Card> : null}

      {data && cfg ? (
        <>
          <Card className="space-y-3 p-4">
            <h2 className="text-sm font-extrabold">{t('mgrConfig')}</h2>
            {!cfg.enabled ? (
              <p className="flex items-start gap-2 text-xs text-amber-800" role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {cfg.reason ?? t('disabledBody')}
              </p>
            ) : null}
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-[11px] text-slate-500">{t('mgrProvider')}</dt><dd className="font-bold">{cfg.provider ?? '—'}</dd></div>
              <div><dt className="text-[11px] text-slate-500">{t('mgrModel')}</dt><dd className="break-all font-bold">{cfg.model ?? '—'}</dd></div>
              <div><dt className="text-[11px] text-slate-500">{t('mgrEndpoint')}</dt><dd className="break-all font-bold">{cfg.baseUrlHost ?? t('mgrDefaultEndpoint')}</dd></div>
              <div><dt className="text-[11px] text-slate-500">{t('mgrKey')}</dt><dd className="font-bold">{cfg.keyConfigured ? t('mgrKeySet') : t('mgrKeyMissing')}</dd></div>
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" onClick={() => void runTest()} disabled={testing || !cfg.enabled}>
                {testing ? t('mgrTesting') : t('mgrTest')}
              </Button>
              {testResult ? (
                <span role="status" className={testResult.ok ? 'text-xs font-bold text-emerald-700' : 'text-xs font-bold text-red-700'}>
                  {testResult.ok ? t('mgrTestOk', { ms: testResult.latencyMs }) : t('mgrTestFail', { code: testResult.code })}
                </span>
              ) : null}
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer font-bold">{t('mgrLimits')}</summary>
              <p className="mt-1 text-slate-500">{t('mgrLimitsHint')}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                {Object.entries(cfg.limits).map(([name, value]) => (
                  <div key={name} className="flex justify-between gap-2"><dt className="text-slate-500">{name}</dt><dd className="font-semibold">{value === null ? '—' : fmt(value)}</dd></div>
                ))}
              </dl>
            </details>
          </Card>

          <section aria-label={t('mgrUsage', { days: data.windowDays })} className="space-y-2">
            <h2 className="text-sm font-extrabold">{t('mgrUsage', { days: data.windowDays })}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('mgrRequests')} value={fmt(data.usage.requests)} />
              <Stat label={t('mgrInTokens')} value={fmt(data.usage.inputTokens)} />
              <Stat label={t('mgrOutTokens')} value={fmt(data.usage.outputTokens)} />
              <Stat label={t('mgrActive')} value={fmt(data.activeTasks)} />
            </div>
            {data.usage.byModel.length > 0 ? (
              <Card className="overflow-x-auto p-3">
                <p className="mb-1 text-xs font-bold">{t('mgrByModel')}</p>
                <table className="w-full text-xs">
                  <tbody>
                    {data.usage.byModel.map((m) => (
                      <tr key={`${m.provider}|${m.model}`} className="border-t border-slate-100">
                        <td className="py-1 pe-2 font-semibold">{m.provider} / {m.model}</td>
                        <td className="py-1 text-end">{fmt(m.requests)}</td>
                        <td className="py-1 text-end">{fmt(m.inputTokens + m.outputTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ) : null}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-extrabold">{t('mgrTasks')}</h2>
            <div className="flex flex-wrap gap-2">
              {Object.keys(data.tasksByStatus).length === 0 ? <p className="text-xs text-slate-500">{t('mgrNone')}</p> : null}
              {Object.entries(data.tasksByStatus).map(([status, count]) => (
                <span key={status} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold dark:bg-slate-900">
                  {status in STATUS_KEYS ? t(STATUS_KEYS[status as keyof typeof STATUS_KEYS]) : status}: {fmt(count)}
                </span>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-extrabold">{t('mgrTools')}</h2>
            {data.tools.length === 0 ? <p className="text-xs text-slate-500">{t('mgrNone')}</p> : (
              <Card className="overflow-x-auto p-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-start text-slate-500">
                      <th className="pb-1 text-start font-semibold" />
                      <th className="pb-1 text-end font-semibold">{t('mgrOk')}</th>
                      <th className="pb-1 text-end font-semibold">{t('mgrFailed')}</th>
                      <th className="pb-1 text-end font-semibold">{t('mgrRejected')}</th>
                      <th className="pb-1 text-end font-semibold">{t('mgrAvgMs')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tools.map((tool) => (
                      <tr key={tool.tool} className="border-t border-slate-100">
                        <td className="py-1 pe-2 font-mono">{tool.tool}</td>
                        <td className="py-1 text-end">{fmt(tool.succeeded)}</td>
                        <td className="py-1 text-end">{fmt(tool.failed)}</td>
                        <td className="py-1 text-end">{fmt(tool.rejected)}</td>
                        <td className="py-1 text-end">{tool.avgLatencyMs === null ? '—' : fmt(tool.avgLatencyMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-extrabold">{t('mgrRecent')}</h2>
            {data.recentTasks.length === 0 ? <p className="text-xs text-slate-500">{t('mgrNone')}</p> : (
              <Card className="overflow-x-auto p-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="pb-1 text-start font-semibold">{t('mgrUser')}</th>
                      <th className="pb-1 text-start font-semibold">{t('mgrStatus')}</th>
                      <th className="pb-1 text-end font-semibold">{t('mgrSteps')}</th>
                      <th className="pb-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentTasks.map((task) => (
                      <tr key={task.id} className="border-t border-slate-100 align-top">
                        <td className="py-1 pe-2 font-mono">{task.userId.slice(0, 8)}</td>
                        <td className="py-1 pe-2">
                          {t(STATUS_KEYS[task.status])}
                          {task.error ? <span className="block text-red-700">{task.error}</span> : null}
                        </td>
                        <td className="py-1 text-end">{task.stepCount} / {task.toolCallCount}</td>
                        <td className="py-1 ps-2 text-end">
                          {isActiveStatus(task.status) ? (
                            <Button type="button" size="sm" variant="outline" disabled={stopping === task.id} onClick={() => void stop(task.id)}>
                              <Square className="me-1 h-3 w-3" aria-hidden="true" />{t('mgrStop')}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>
        </>
      ) : loading ? (
        <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t('loading')}</p>
      ) : null}
    </div>
  )
}
