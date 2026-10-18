import { describe, expect, it } from 'vitest'
import { DICTIONARIES, LOCALES, detectLocale, directionOf, isLocale, translate, type MessageKey } from '@/lib/i18n'

const keys = Object.keys(DICTIONARIES.en) as MessageKey[]
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('assistant translations', () => {
  it('supports Arabic, English and French', () => {
    expect([...LOCALES].sort()).toEqual(['ar', 'en', 'fr'])
  })

  it('defines every key in every language with non-empty text', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(DICTIONARIES[locale]).sort(), locale).toEqual([...keys].sort())
      for (const key of keys) expect(DICTIONARIES[locale][key].trim().length, `${locale}.${key}`).toBeGreaterThan(0)
    }
  })

  it('keeps interpolation placeholders identical across languages', () => {
    for (const key of keys) {
      const expected = placeholders(DICTIONARIES.en[key])
      for (const locale of LOCALES) expect(placeholders(DICTIONARIES[locale][key]), `${locale}.${key}`).toEqual(expected)
    }
  })

  it('actually translates (Arabic uses Arabic script, French differs from English)', () => {
    for (const key of ['title', 'approve', 'reject', 'statusCompleted', 'send'] as const) {
      expect(DICTIONARIES.ar[key]).toMatch(/[؀-ۿ]/)
      expect(DICTIONARIES.fr[key]).not.toBe(DICTIONARIES.en[key])
    }
  })

  it('renders right-to-left only for Arabic', () => {
    expect(directionOf('ar')).toBe('rtl')
    expect(directionOf('en')).toBe('ltr')
    expect(directionOf('fr')).toBe('ltr')
  })

  it('interpolates parameters and validates locale codes', () => {
    expect(translate('en', 'confirmAffected', { n: 3 })).toBe('Affected items: 3')
    expect(translate('fr', 'confirmExpires', { time: '04:59' })).toContain('04:59')
    expect(translate('ar', 'confirmExpires', { time: '04:59' })).toContain('04:59')
    expect(isLocale('ar')).toBe(true)
    expect(isLocale('de')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })

  it('detects a stored or browser locale and falls back to English', () => {
    window.localStorage.setItem('9drive.locale', 'fr')
    expect(detectLocale()).toBe('fr')
    window.localStorage.setItem('9drive.locale', 'xx')
    expect(['en', 'ar', 'fr']).toContain(detectLocale())
    window.localStorage.clear()
  })
})
