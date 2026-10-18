import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationCard } from '@/components/assistant/ConfirmationCard'
import type { ConfirmationDto } from '@/lib/assistant'
import { translate, type Locale, type Translate } from '@/lib/i18n'

afterEach(cleanup)

const NOW = Date.parse('2026-10-18T10:00:00Z')
const tFor = (locale: Locale): Translate => (key, params) => translate(locale, key, params)

function confirmation(overrides: Partial<ConfirmationDto> = {}): ConfirmationDto {
  return {
    id: 'c1',
    status: 'PENDING',
    tool: 'trash_files',
    risk: 'medium',
    summary: 'Move 2 file(s) (1.0 MB) to the Recycle Bin',
    preview: { affectedCount: 2, sample: ['a.pdf', 'b.pdf'], warnings: ['Files stay recoverable until permanently deleted.'] },
    argsHash: 'a'.repeat(64),
    expiresAt: '2026-10-18T10:05:00Z',
    ...overrides,
  }
}

function setup(over: Partial<ConfirmationDto> = {}, props: { busy?: boolean; locale?: Locale } = {}) {
  const onApprove = vi.fn()
  const onReject = vi.fn()
  render(<ConfirmationCard confirmation={confirmation(over)} t={tFor(props.locale ?? 'en')} busy={props.busy ?? false} onApprove={onApprove} onReject={onReject} now={() => NOW} />)
  return { onApprove, onReject }
}

describe('ConfirmationCard', () => {
  it('describes the real action, risk, affected count, examples and warnings', () => {
    setup()
    expect(screen.getByText('Approve this action?')).toBeTruthy()
    expect(screen.getByText('Medium risk')).toBeTruthy()
    expect(screen.getByText('Move 2 file(s) (1.0 MB) to the Recycle Bin')).toBeTruthy()
    expect(screen.getByText('Affected items: 2')).toBeTruthy()
    expect(screen.getByText('a.pdf')).toBeTruthy()
    expect(screen.getByText('Files stay recoverable until permanently deleted.')).toBeTruthy()
    expect(screen.getByText('Expires in 05:00')).toBeTruthy()
  })

  it('renders untrusted names strictly as text (no HTML injection)', () => {
    setup({ preview: { affectedCount: 1, sample: ['<img src=x onerror="alert(1)">'], warnings: [] } })
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  it('approves and declines through real buttons, with the keyboard too', async () => {
    const user = userEvent.setup()
    const { onApprove, onReject } = setup()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onReject).toHaveBeenCalledTimes(1)
    screen.getByRole('button', { name: 'Approve' }).focus()
    await user.keyboard('{Enter}')
    expect(onApprove).toHaveBeenCalledTimes(2)
  })

  it('moves focus to the card so keyboard users land on the decision', () => {
    setup()
    expect(document.activeElement).toBe(screen.getByTestId('confirmation-card'))
    expect(screen.getByRole('group', { name: 'Approve this action?' })).toBeTruthy()
  })

  it('requires an explicit acknowledgement before approving a high-risk action', async () => {
    const user = userEvent.setup()
    const { onApprove } = setup({ risk: 'high', summary: 'PERMANENTLY delete 3 file(s)' })
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    await user.click(approve)
    expect(onApprove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox'))
    expect(approve.disabled).toBe(false)
    await user.click(approve)
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('blocks approval once expired and announces it', () => {
    setup({ expiresAt: '2026-10-18T09:59:00Z' })
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('expired')
  })

  it('disables both actions while a decision is in flight', () => {
    setup({}, { busy: true })
    expect((screen.getByRole('button', { name: 'Approving…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('is fully translated (Arabic and French)', () => {
    setup({}, { locale: 'ar' })
    expect(screen.getByText('هل توافق على هذا الإجراء؟')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'موافقة' })).toBeTruthy()
    cleanup()
    setup({}, { locale: 'fr' })
    expect(screen.getByText('Approuver cette action ?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refuser' })).toBeTruthy()
  })
})
