import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Copy, MinusCircle, XCircle } from 'lucide-react'
import { STEP_KEYS, humanizeTool, type StepDto } from '@/lib/assistant'
import type { Translate } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const ICONS: Record<StepDto['status'], { icon: typeof CheckCircle2; className: string }> = {
  SUCCEEDED: { icon: CheckCircle2, className: 'text-emerald-600' },
  FAILED: { icon: XCircle, className: 'text-red-600' },
  REJECTED: { icon: MinusCircle, className: 'text-slate-500' },
  PENDING_CONFIRMATION: { icon: Clock, className: 'text-amber-600' },
  SKIPPED: { icon: AlertTriangle, className: 'text-slate-500' },
}

function CopyButton({ value, t }: { value: string; t: Translate }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold hover:bg-slate-50"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => undefined)
      }}
    >
      <Copy className="h-3 w-3" aria-hidden="true" />
      {copied ? t('copied') : t('copy')}
    </button>
  )
}

export function StepList({ steps, t }: { steps: StepDto[]; t: Translate }) {
  if (steps.length === 0) return null
  return (
    <ol className="grid gap-2" aria-label="steps">
      {steps.map((step) => {
        const { icon: Icon, className } = ICONS[step.status]
        const url = typeof step.userOutput?.url === 'string' ? step.userOutput.url : null
        return (
          <li key={step.id} className="rounded-xl border border-slate-200 bg-white/70 p-3 text-xs dark:bg-slate-900" data-testid="step">
            <div className="flex flex-wrap items-center gap-2">
              <Icon className={cn('h-4 w-4 shrink-0', className)} aria-hidden="true" />
              <span className="font-bold">{humanizeTool(step.tool)}</span>
              <span className="text-slate-500">{t(STEP_KEYS[step.status])}</span>
            </div>
            {step.summary ? <p className="mt-1 text-slate-700 dark:text-slate-300">{step.summary}</p> : null}
            {step.verification ? <p className="mt-1 text-emerald-700">{t('verified')}: {step.verification}</p> : null}
            {url ? (
              <div className="mt-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800">
                <p className="text-[11px] text-slate-500">{t('userOnlyOutput')}</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all text-[11px]" dir="ltr">{url}</code>
                  <CopyButton value={url} t={t} />
                </div>
              </div>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
