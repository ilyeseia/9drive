import { useEffect, useId, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RISK_KEYS, remainingTime, humanizeTool, type ConfirmationDto } from '@/lib/assistant'
import type { Translate } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const RISK_STYLES: Record<ConfirmationDto['risk'], string> = {
  low: 'bg-emerald-50 text-emerald-700',
  medium: 'bg-amber-50 text-amber-700',
  high: 'bg-red-50 text-red-700',
}

interface Props {
  confirmation: ConfirmationDto
  t: Translate
  busy: boolean
  onApprove: () => void
  onReject: () => void
  /** Test seam for a deterministic clock. */
  now?: () => number
}

/**
 * The backend, not this card, enforces confirmation: approving sends the argument hash that was
 * shown so an altered action is rejected. High-risk actions also need an explicit acknowledgement.
 */
export function ConfirmationCard({ confirmation, t, busy, onApprove, onReject, now = Date.now }: Props) {
  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  const [tick, setTick] = useState(() => now())
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    cardRef.current?.focus()
  }, [confirmation.id])

  useEffect(() => {
    const timer = window.setInterval(() => setTick(now()), 1000)
    return () => window.clearInterval(timer)
  }, [now])

  const remaining = remainingTime(confirmation.expiresAt, tick)
  const expired = remaining === null
  const needsAck = confirmation.risk === 'high'
  const canApprove = !busy && !expired && (!needsAck || acknowledged)
  const sample = confirmation.preview?.sample ?? []
  const warnings = confirmation.preview?.warnings ?? []
  const affected = confirmation.preview?.affectedCount

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-labelledby={titleId}
      data-testid="confirmation-card"
      className="rounded-2xl border border-amber-300 bg-amber-50/60 p-4 text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-amber-600" aria-hidden="true" />
        <h3 id={titleId} className="text-sm font-extrabold">{t('confirmTitle')}</h3>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', RISK_STYLES[confirmation.risk])}>{t(RISK_KEYS[confirmation.risk])}</span>
        <span className="text-xs text-slate-500 dark:text-slate-400">{humanizeTool(confirmation.tool)}</span>
      </div>

      <p className="mt-3 text-sm font-semibold">{confirmation.summary}</p>
      {typeof affected === 'number' ? <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{t('confirmAffected', { n: affected })}</p> : null}

      {sample.length > 0 ? (
        <div className="mt-2">
          <p className="text-xs font-bold text-slate-600 dark:text-slate-300">{t('confirmSample')}</p>
          <ul className="mt-1 list-disc ps-5 text-xs text-slate-700 dark:text-slate-200">
            {sample.map((entry, index) => (
              // Rendered as text only: names come from storage and are untrusted.
              <li key={`${index}-${entry}`} className="break-all">{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="mt-2 rounded-xl bg-white/70 p-2 dark:bg-slate-800">
          <p className="text-xs font-bold text-amber-700 dark:text-amber-300">{t('confirmWarnings')}</p>
          <ul className="mt-1 list-disc ps-5 text-xs text-slate-700 dark:text-slate-200">
            {warnings.map((entry, index) => <li key={`${index}-${entry}`}>{entry}</li>)}
          </ul>
        </div>
      ) : null}

      {needsAck && !expired ? (
        <label className="mt-3 flex items-start gap-2 text-xs font-semibold">
          <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>{t('confirmUnderstand')}</span>
        </label>
      ) : null}

      <p className={cn('mt-3 text-xs', expired ? 'font-bold text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')} role={expired ? 'alert' : undefined}>
        {expired ? t('confirmExpired') : t('confirmExpires', { time: remaining })}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" onClick={onApprove} disabled={!canApprove}>{busy ? t('approving') : t('approve')}</Button>
        <Button type="button" variant="outline" onClick={onReject} disabled={busy}>{t('reject')}</Button>
      </div>
    </div>
  )
}
