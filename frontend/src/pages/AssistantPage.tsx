import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AlertTriangle, Bot, Copy, Loader2, Menu, MessageSquare, Plus, RefreshCw, Send, Square, Trash2 } from 'lucide-react'
import { ConfirmationCard } from '@/components/assistant/ConfirmationCard'
import { StepList } from '@/components/assistant/StepList'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  STATUS_KEYS,
  assistantApi,
  errorKeyFor,
  isBusy,
  isFinished,
  mergeMessages,
  shouldPoll,
  type AssistantStatus,
  type ChatMessage,
  type ConversationSummary,
  type TaskView,
} from '@/lib/assistant'
import { LOCALES, LOCALE_NAMES, isLocale, useLocale, type MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const QUICK_ACTIONS: Array<{ tool: string; label: MessageKey }> = [
  { tool: 'list_storage_accounts', label: 'qaAccounts' },
  { tool: 'storage_usage_report', label: 'qaUsage' },
  { tool: 'provider_health_summary', label: 'qaHealth' },
  { tool: 'find_accounts_needing_attention', label: 'qaAttention' },
]

const EXAMPLES: MessageKey[] = ['example1', 'example2', 'example3']

function CopyText({ value, label, copiedLabel }: { value: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => undefined)
      }}
    >
      <Copy className="h-3 w-3" aria-hidden="true" />
      {copied ? copiedLabel : label}
    </button>
  )
}

export function AssistantPage({ pollMs = 1200 }: { pollMs?: number }) {
  const { locale, setLocale, t, dir } = useLocale()
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [taskId, setTaskId] = useState<string | null>(null)
  const [view, setView] = useState<TaskView | null>(null)
  const [pollVersion, setPollVersion] = useState(0)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey | null>(null)
  const [loading, setLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [quick, setQuick] = useState<{ label: string; summary: string; json: string } | null>(null)
  const [quickBusy, setQuickBusy] = useState<string | null>(null)
  const afterSeq = useRef(0)
  const logRef = useRef<HTMLDivElement>(null)

  const loadConversations = useCallback(async () => {
    const data = await assistantApi.listConversations()
    setConversations(data.conversations)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [s] = await Promise.all([assistantApi.status(), loadConversations()])
        if (!cancelled) setStatus(s)
      } catch (error) {
        if (!cancelled) setErrorKey(errorKeyFor(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadConversations])

  const applyView = useCallback((next: TaskView) => {
    setView(next)
    if (next.messages.length > 0) {
      afterSeq.current = Math.max(afterSeq.current, ...next.messages.map((m) => m.seq))
      setMessages((current) => {
        const cleaned = next.messages.some((m) => m.role === 'user') ? current.filter((m) => !m.id.startsWith('local-')) : current
        return mergeMessages(cleaned, next.messages)
      })
    }
  }, [])

  // Poll while the server works; stop while the user must decide or the task is finished.
  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    let timer = 0
    const tick = async () => {
      try {
        const next = await assistantApi.getTask(taskId, afterSeq.current)
        if (cancelled) return
        applyView(next)
        if (shouldPoll(next.task.status)) timer = window.setTimeout(tick, pollMs)
        else if (isFinished(next.task.status)) loadConversations().catch(() => undefined)
      } catch (error) {
        if (!cancelled) setErrorKey(errorKeyFor(error))
      }
    }
    void tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [taskId, pollVersion, pollMs, applyView, loadConversations])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, view])

  const resetConversation = () => {
    setActiveId(null)
    setMessages([])
    setTaskId(null)
    setView(null)
    afterSeq.current = 0
    setErrorKey(null)
  }

  async function openConversation(id: string) {
    setErrorKey(null)
    setSidebarOpen(false)
    try {
      const data = await assistantApi.getConversation(id)
      setActiveId(id)
      setMessages(data.messages)
      afterSeq.current = Math.max(0, ...data.messages.map((m) => m.seq))
      setView(null)
      setTaskId(data.activeTaskId)
      setPollVersion((v) => v + 1)
    } catch (error) {
      setErrorKey(errorKeyFor(error))
    }
  }

  async function removeConversation(id: string) {
    if (!window.confirm(t('deleteChatConfirm'))) return
    try {
      await assistantApi.deleteConversation(id)
      setConversations((current) => current.filter((c) => c.id !== id))
      if (id === activeId) resetConversation()
    } catch (error) {
      setErrorKey(errorKeyFor(error))
    }
  }

  const taskStatus = view?.task.status ?? null
  const busy = taskStatus !== null && isBusy(taskStatus)
  const awaiting = taskStatus === 'AWAITING_CONFIRMATION'
  const locked = busy || awaiting || sending

  async function send(raw: string) {
    const text = raw.trim()
    if (!text || locked || !status?.enabled) return
    setSending(true)
    setErrorKey(null)
    const localId = `local-${Date.now()}`
    try {
      let id = activeId
      if (!id) {
        const created = await assistantApi.createConversation(locale)
        id = created.conversation.id
        setActiveId(id)
        setConversations((current) => [created.conversation, ...current])
      }
      setMessages((current) => [...current, { id: localId, seq: Number.POSITIVE_INFINITY, role: 'user', content: text, taskId: null, createdAt: new Date().toISOString() }])
      setInput('')
      const { task } = await assistantApi.sendMessage(id, text, locale)
      setView({ task, steps: [], confirmation: null, messages: [] })
      setTaskId(task.id)
      setPollVersion((v) => v + 1)
    } catch (error) {
      setMessages((current) => current.filter((m) => m.id !== localId))
      setInput(text)
      setErrorKey(errorKeyFor(error))
    } finally {
      setSending(false)
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void send(input)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send(input)
    }
  }

  async function decide(kind: 'approve' | 'reject') {
    const confirmation = view?.confirmation
    if (!confirmation || deciding) return
    setDeciding(true)
    setErrorKey(null)
    try {
      if (kind === 'approve') await assistantApi.approve(confirmation.id, confirmation.argsHash)
      else await assistantApi.reject(confirmation.id)
      setPollVersion((v) => v + 1)
    } catch (error) {
      setErrorKey(errorKeyFor(error))
      setPollVersion((v) => v + 1)
    } finally {
      setDeciding(false)
    }
  }

  async function stop() {
    if (!taskId) return
    try {
      await assistantApi.cancelTask(taskId)
      setPollVersion((v) => v + 1)
    } catch (error) {
      setErrorKey(errorKeyFor(error))
    }
  }

  async function runQuick(tool: string, label: MessageKey) {
    setQuickBusy(tool)
    setErrorKey(null)
    try {
      const result = await assistantApi.runTool(tool)
      setQuick({ label: t(label), summary: result.summary, json: JSON.stringify(result.data, null, 2).slice(0, 6000) })
    } catch (error) {
      setErrorKey(errorKeyFor(error))
    } finally {
      setQuickBusy(null)
    }
  }

  // The final assistant message of a finished task is preceded by that task's steps.
  const stepsBeforeMessageId =
    view && isFinished(view.task.status) && view.steps.length > 0
      ? ([...messages].reverse().find((m) => m.role === 'assistant' && m.taskId === view.task.id)?.id ?? null)
      : null
  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const statusText = taskStatus ? t(STATUS_KEYS[taskStatus]) : ''
  const enabled = status?.enabled === true

  if (loading) {
    return (
      <Card className="mt-6 flex items-center justify-center gap-2 p-12 text-slate-500" dir={dir}>
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <span>{t('loading')}</span>
      </Card>
    )
  }

  return (
    <div dir={dir} lang={locale} className="mt-2 flex min-h-[70dvh] flex-col gap-4 lg:flex-row" data-testid="assistant-root">
      <aside id="assistant-sidebar" className={cn('w-full shrink-0 lg:block lg:w-64', sidebarOpen ? 'block' : 'hidden')} aria-label={t('conversations')}>
        <Card className="flex h-full flex-col gap-2 p-3">
          <Button type="button" size="sm" onClick={resetConversation}><Plus className="h-4 w-4" aria-hidden="true" />{t('newChat')}</Button>
          <nav className="mt-1 grid gap-1 overflow-y-auto" aria-label={t('conversations')}>
            {conversations.length === 0 ? <p className="p-2 text-xs text-slate-500">{t('noConversations')}</p> : null}
            {conversations.map((c) => (
              <div key={c.id} className={cn('group flex items-center gap-1 rounded-xl', c.id === activeId ? 'bg-blue-600/10' : 'hover:bg-slate-100')}>
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-start text-xs font-semibold" aria-current={c.id === activeId ? 'true' : undefined} onClick={() => void openConversation(c.id)}>
                  <MessageSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{c.title || t('untitled')}</span>
                </button>
                <button type="button" className="rounded-lg p-2 text-slate-400 hover:text-red-600" aria-label={`${t('deleteChat')}: ${c.title || t('untitled')}`} onClick={() => void removeConversation(c.id)}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ))}
          </nav>
        </Card>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-3" aria-label={t('title')}>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="rounded-xl border border-slate-200 p-2 lg:hidden" aria-expanded={sidebarOpen} aria-controls="assistant-sidebar" aria-label={sidebarOpen ? t('closeMenu') : t('openMenu')} onClick={() => setSidebarOpen((v) => !v)}>
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <Bot className="h-6 w-6 text-blue-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-extrabold tracking-tight">{t('title')}</h1>
            <p className="text-xs text-slate-500">{t('subtitle')}</p>
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold">
            <span>{t('language')}</span>
            <select className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-sm" value={locale} onChange={(event) => isLocale(event.target.value) && setLocale(event.target.value)}>
              {LOCALES.map((code) => <option key={code} value={code}>{LOCALE_NAMES[code]}</option>)}
            </select>
          </label>
        </div>

        {!enabled ? (
          <Card className="border-amber-200 bg-amber-50 p-4" role="alert">
            <div className="flex items-start gap-3 text-amber-800">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm font-extrabold">{t('disabledTitle')}</p>
                <p className="mt-1 text-xs">{t('disabledBody')}</p>
                {status?.reason ? <p className="mt-1 text-xs"><span className="font-bold">{t('reasonLabel')}:</span> {status.reason}</p> : null}
              </div>
            </div>
          </Card>
        ) : null}

        <details className="rounded-2xl border border-slate-200 bg-white/60 p-3 dark:bg-slate-900" open={!enabled}>
          <summary className="cursor-pointer text-sm font-bold">{t('degradedTitle')}</summary>
          <p className="mt-1 text-xs text-slate-500">{t('degradedHint')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {QUICK_ACTIONS.map((action) => (
              <Button key={action.tool} type="button" size="sm" variant="outline" disabled={quickBusy !== null} onClick={() => void runQuick(action.tool, action.label)}>
                {quickBusy === action.tool ? t('qaRunning') : t(action.label)}
              </Button>
            ))}
          </div>
          {quick ? (
            <div className="mt-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800" data-testid="quick-result">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-bold">{quick.label}: {quick.summary}</p>
                <CopyText value={quick.json} label={t('copy')} copiedLabel={t('copied')} />
              </div>
              <pre className="mt-2 max-h-64 overflow-auto text-[11px]" dir="ltr">{quick.json}</pre>
            </div>
          ) : null}
        </details>

        <Card className="flex min-h-[320px] flex-1 flex-col overflow-hidden p-0">
          <div ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label={t('title')} className="flex-1 space-y-3 overflow-y-auto p-4" data-testid="message-log">
            {messages.length === 0 && !view ? (
              <div className="grid gap-2 text-sm text-slate-600">
                <p className="font-semibold">{t('emptyHint')}</p>
                {EXAMPLES.map((key) => (
                  <button key={key} type="button" disabled={!enabled} className="rounded-xl border border-slate-200 p-3 text-start text-xs font-semibold hover:bg-slate-50 disabled:opacity-50" onClick={() => setInput(t(key))}>
                    {t(key)}
                  </button>
                ))}
              </div>
            ) : null}

            {messages.map((message) => (
              <Fragment key={message.id}>
              {message.id === stepsBeforeMessageId && view ? <StepList steps={view.steps} t={t} /> : null}
              <div className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[85%] rounded-2xl px-4 py-2 text-sm', message.role === 'user' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100')}>
                  <p className="mb-1 text-[11px] font-bold opacity-70">{message.role === 'user' ? t('you') : t('assistant')}</p>
                  {/* Plain text only: assistant output is never interpreted as HTML. */}
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  {message.role === 'assistant' ? <div className="mt-1"><CopyText value={message.content} label={t('copy')} copiedLabel={t('copied')} /></div> : null}
                </div>
              </div>
              </Fragment>
            ))}

            {/* While a task is running its steps trail the transcript; once it has answered they sit just before the answer. */}
            {view && view.steps.length > 0 && stepsBeforeMessageId === null ? <StepList steps={view.steps} t={t} /> : null}

            {view?.confirmation && awaiting ? (
              <ConfirmationCard confirmation={view.confirmation} t={t} busy={deciding} onApprove={() => void decide('approve')} onReject={() => void decide('reject')} />
            ) : null}

            {busy ? (
              <p className="flex items-center gap-2 text-xs font-semibold text-slate-500" data-testid="busy-indicator">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {statusText}
              </p>
            ) : null}
          </div>

          <div className="sr-only" role="status" aria-live="polite">{statusText}</div>

          {taskStatus && isFinished(taskStatus) ? (
            <div className={cn('flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs font-bold', taskStatus === 'COMPLETED' || taskStatus === 'AWAITING_CLARIFICATION' ? 'text-emerald-700' : taskStatus === 'PARTIALLY_COMPLETED' ? 'text-amber-700' : 'text-red-700')} data-testid="task-outcome">
              <span>{statusText}</span>
              {taskStatus === 'FAILED' && lastUserText ? (
                <Button type="button" size="sm" variant="outline" onClick={() => void send(lastUserText)} disabled={locked || !enabled}><RefreshCw className="h-3 w-3" aria-hidden="true" />{t('retry')}</Button>
              ) : null}
            </div>
          ) : null}

          {errorKey ? <p role="alert" className="border-t bg-red-50 px-4 py-2 text-xs font-semibold text-red-700">{t(errorKey)}</p> : null}

          <form onSubmit={onSubmit} className="flex items-end gap-2 border-t p-3">
            <textarea
              className="max-h-40 min-h-[44px] flex-1 resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 disabled:opacity-60"
              placeholder={t('placeholder')}
              aria-label={t('placeholder')}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={!enabled || locked}
              maxLength={4000}
              rows={1}
            />
            {busy || awaiting ? (
              <Button type="button" variant="outline" onClick={() => void stop()}><Square className="h-4 w-4" aria-hidden="true" />{t('cancelTask')}</Button>
            ) : null}
            <Button type="submit" disabled={!enabled || locked || input.trim() === ''}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />}
              {t('send')}
            </Button>
          </form>
        </Card>
        <p className="text-[11px] text-slate-400">{t('noTokenStreaming')}</p>
      </section>
    </div>
  )
}
