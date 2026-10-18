import { ApiError } from '../api/errors';
import { FSI, PDI, RLO, isBidiControl } from '../core/bidi';
import { errorMessageKey } from './I18nProvider';
import { formatBytes, formatDate, formatPercent, isolate, ltr } from './format';
import { LOCALES, MESSAGES, isRtl, matchLocale, translate, type MessageKey } from './messages';

const keys = Object.keys(MESSAGES.en) as MessageKey[];

describe('catalogue', () => {
  it('has every key in every locale, with no empty strings', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual([...keys].sort());
      for (const key of keys) expect(MESSAGES[locale][key].trim()).not.toBe('');
    }
  });

  it('uses the same placeholders in every translation', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keys) {
      for (const locale of LOCALES) expect(placeholders(MESSAGES[locale][key])).toEqual(placeholders(MESSAGES.en[key]));
    }
  });

  it('interpolates parameters', () => {
    expect(translate('en', 'appName')).toBe('9Drive');
    expect(translate('ar', 'tabFiles')).toBe('الملفات');
  });
});

describe('locale selection', () => {
  it('matches device language codes and falls back to English', () => {
    expect(matchLocale('ar')).toBe('ar');
    expect(matchLocale('ar-SA')).toBe('ar');
    expect(matchLocale('fr_CA')).toBe('fr');
    expect(matchLocale('de')).toBe('en');
    expect(matchLocale(null)).toBe('en');
  });

  it('knows which locales are right-to-left', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(isRtl('fr')).toBe(false);
  });
});

describe('error messages', () => {
  it('maps every error kind to a translated user message and never to raw text', () => {
    const kinds: ApiError['kind'][] = [
      'offline',
      'timeout',
      'cancelled',
      'unauthorized',
      'disabled',
      'forbidden',
      'not_found',
      'conflict',
      'validation',
      'rate_limited',
      'quota',
      'server',
      'unavailable',
      'invalid_response',
      'unknown',
    ];
    for (const kind of kinds) {
      const key = errorMessageKey(new ApiError(kind, null, null, 'SERVER SAID: stack trace at /srv/app.ts:1'));
      expect(MESSAGES.en[key]).not.toContain('stack');
    }
    expect(errorMessageKey(new Error('boom'))).toBe('errUnknown');
  });
});

describe('formatting', () => {
  it('formats bytes in a left-to-right isolate with sensible precision', () => {
    expect(formatBytes(0, 'en')).toBe(ltr('0 B'));
    expect(formatBytes(1536, 'en')).toBe(ltr('1.5 KB'));
    expect(formatBytes(5 * 1024 ** 3, 'en')).toBe(ltr('5 GB'));
    expect(formatBytes(NaN, 'en')).toBe('—');
    expect(formatBytes(-1, 'en')).toBe('—');
  });

  it('formats percent and dates without throwing for any locale', () => {
    for (const locale of LOCALES) {
      expect(formatPercent(0.256, locale)).toMatch(/\d/);
      expect(formatDate('2026-10-18T10:00:00Z', locale)).not.toBe('—');
    }
    expect(formatDate('not a date', 'en')).toBe('—');
    expect(formatPercent(7, 'en')).toMatch(/100/);
  });

  it('isolates untrusted text and strips embedded bidi controls that could break out of the isolate', () => {
    const evil = `invoice${RLO}txt.exe${PDI} pwned`;
    const out = isolate(evil);
    expect(out.startsWith(FSI)).toBe(true);
    expect(out.endsWith(PDI)).toBe(true);
    const inner = out.slice(1, -1);
    expect([...inner].some((ch) => isBidiControl(ch.codePointAt(0) ?? 0))).toBe(false);
    expect(inner).toBe('invoicetxt.exe pwned');
  });
});
