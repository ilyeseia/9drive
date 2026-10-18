import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { CheckCircle2, Loader2, Pencil, Plus, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ApiError } from '@/lib/api'
import { modelsApi, type ModelInput, type ModelProfile, type ModelsResponse, type ProbeOutcome } from '@/lib/assistant'
import { useLocale } from '@/lib/i18n'

const PROVIDERS = [
  { id: 'openai_compatible', label: 'OpenAI-compatible' },
  { id: 'anthropic', label: 'Anthropic' },
] as const

interface FormState {
  id: string | null
  name: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

const EMPTY: FormState = { id: null, name: '', provider: 'openai_compatible', model: '', baseUrl: '', apiKey: '' }

function toInput(form: FormState): ModelInput {
  const input: ModelInput = { name: form.name.trim(), provider: form.provider, model: form.model.trim(), baseUrl: form.baseUrl.trim() || null }
  // An empty key field while editing means "keep the stored key" (the field is simply omitted).
  if (form.apiKey.trim() !== '') input.apiKey = form.apiKey.trim()
  return input
}

export function ModelsPanel({ onChanged }: { onChanged?: () => void }) {
  const { t } = useLocale()
  const [data, setData] = useState<ModelsResponse | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formTest, setFormTest] = useState<ProbeOutcome | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await modelsApi.list())
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('errorGeneric'))
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  async function run<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusy(key)
    setError(null)
    try {
      const result = await action()
      return result
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('errorGeneric'))
      return undefined
    } finally {
      setBusy(null)
    }
  }

  async function refresh() {
    await load()
    onChanged?.()
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!form) return
    const input = toInput(form)
    const saved = await run('save', () => (form.id ? modelsApi.update(form.id, input) : modelsApi.create(input)))
    if (saved) {
      setForm(null)
      setFormTest(null)
      await refresh()
    }
  }

  async function testForm() {
    if (!form) return
    setFormTest(null)
    const result = await run('form-test', () => modelsApi.testDraft(toInput(form), form.id ?? undefined))
    if (result) setFormTest(result)
  }

  async function testSaved(profile: ModelProfile) {
    if (await run(`test-${profile.id}`, () => modelsApi.test(profile.id))) await refresh()
  }

  async function activate(profile: ModelProfile) {
    if (await run(`use-${profile.id}`, () => modelsApi.activate(profile.id))) await refresh()
  }

  async function useEnvironment() {
    if (await run('env', () => modelsApi.useEnvironment())) await refresh()
  }

  async function remove(profile: ModelProfile) {
    if (!window.confirm(t('mdlDeleteConfirm'))) return
    if (await run(`del-${profile.id}`, () => modelsApi.remove(profile.id))) await refresh()
  }

  function edit(profile: ModelProfile) {
    setFormTest(null)
    setForm({ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl ?? '', apiKey: '' })
  }

  const env = data?.environment
  const envActive = data !== null && data.activeId === null
  const canSubmit = form !== null && form.name.trim() !== '' && form.model.trim() !== ''

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-extrabold">{t('mdlTitle')}</h2>
        {form === null ? (
          <Button type="button" size="sm" onClick={() => { setFormTest(null); setForm({ ...EMPTY }) }}>
            <Plus className="me-1 h-4 w-4" aria-hidden="true" />{t('mdlAdd')}
          </Button>
        ) : null}
      </div>

      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p> : null}

      {form ? (
        <form onSubmit={(event) => void save(event)} className="space-y-3 rounded-2xl border border-slate-200 p-3" aria-label={form.id ? t('mdlEdit') : t('mdlAdd')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-semibold">
              <span>{t('mdlName')}</span>
              <input className="h-9 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs font-semibold">
              <span>{t('mgrProvider')}</span>
              <select className="h-9 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs font-semibold">
              <span>{t('mgrModel')}</span>
              <input className="h-9 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm" value={form.model} maxLength={128} placeholder="auto" onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs font-semibold">
              <span>{t('mdlBaseUrl')}</span>
              <input className="h-9 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm" dir="ltr" inputMode="url" value={form.baseUrl} placeholder="https://host/v1" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            </label>
            <label className="space-y-1 text-xs font-semibold sm:col-span-2">
              <span>{t('mdlApiKey')}</span>
              <input
                className="h-9 w-full rounded-xl border border-slate-200 bg-white px-2 text-sm"
                dir="ltr"
                type="password"
                autoComplete="new-password"
                value={form.apiKey}
                placeholder={form.id ? t('mdlKeyKeep') : ''}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
              <span className="block text-[11px] font-normal text-slate-500">{t('mdlKeyHint')}</span>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={!canSubmit || busy !== null} onClick={() => void testForm()}>
              {busy === 'form-test' ? t('mgrTesting') : t('mgrTest')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit || busy !== null}>{t('mdlSave')}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => { setForm(null); setFormTest(null) }}>{t('mdlCancel')}</Button>
            {formTest ? (
              <span role="status" className={formTest.ok ? 'text-xs font-bold text-emerald-700' : 'text-xs font-bold text-red-700'}>
                {formTest.ok ? t('mgrTestOk', { ms: formTest.latencyMs }) : t('mgrTestFail', { code: formTest.code ?? 'MODEL_UNAVAILABLE' })}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      <ul className="space-y-2">
        {env ? (
          <li className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 p-3">
            <div className="min-w-0 text-xs">
              <p className="text-sm font-bold">{t('mdlEnvironment')} {envActive ? <span className="ms-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">{t('mdlActive')}</span> : null}</p>
              <p className="text-slate-500">{env.enabled ? `${env.provider} · ${env.model}${env.baseUrlHost ? ` · ${env.baseUrlHost}` : ''}` : (env.reason ?? '—')}</p>
            </div>
            {!envActive ? (
              <Button type="button" size="sm" variant="outline" disabled={busy !== null} title={t('mdlUseEnvHint')} onClick={() => void useEnvironment()}>{t('mdlUse')}</Button>
            ) : null}
          </li>
        ) : null}

        {data && data.profiles.length === 0 ? <li className="text-xs text-slate-500">{t('mdlNone')}</li> : null}

        {data?.profiles.map((profile) => (
          <li key={profile.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 p-3">
            <div className="min-w-0 text-xs">
              <p className="text-sm font-bold">
                {profile.name}
                {profile.isActive ? <span className="ms-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">{t('mdlActive')}</span> : null}
              </p>
              <p className="break-all text-slate-500">
                {profile.provider} · {profile.model}{profile.baseUrl ? ` · ${new URL(profile.baseUrl).host}` : ''} · {profile.hasKey ? t('mgrKeySet') : t('mgrKeyMissing')}
              </p>
              <p className="mt-0.5 flex items-center gap-1">
                {profile.lastTest === null ? (
                  <span className="text-slate-500">{t('mdlNeverTested')}</span>
                ) : profile.lastTest.ok ? (
                  <span className="flex items-center gap-1 font-semibold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />{t('mdlTestedOk', { ms: profile.lastTest.latencyMs ?? 0 })}</span>
                ) : (
                  <span className="flex items-center gap-1 font-semibold text-red-700"><XCircle className="h-3.5 w-3.5" aria-hidden="true" />{t('mdlTestedFail', { code: profile.lastTest.code ?? '?' })}</span>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void testSaved(profile)}>
                {busy === `test-${profile.id}` ? <Loader2 className="h-4 w-4 animate-spin" aria-label={t('mgrTesting')} /> : t('mgrTest')}
              </Button>
              {!profile.isActive ? <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void activate(profile)}>{t('mdlUse')}</Button> : null}
              <Button type="button" size="sm" variant="outline" disabled={busy !== null} aria-label={`${t('mdlEdit')} ${profile.name}`} onClick={() => edit(profile)}><Pencil className="h-4 w-4" aria-hidden="true" /></Button>
              <Button type="button" size="sm" variant="outline" disabled={busy !== null} aria-label={`${t('mdlDelete')} ${profile.name}`} onClick={() => void remove(profile)}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
