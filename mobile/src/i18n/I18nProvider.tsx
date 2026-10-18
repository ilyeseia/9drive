import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nManager } from 'react-native';
import { getLocales } from 'expo-localization';
import { readPref, writePref } from '../core/prefs';
import { ApiError } from '../api/errors';
import { LOCALES, isLocale, isRtl, matchLocale, translate, type Locale, type MessageKey } from './messages';

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  rtl: boolean;
  t: Translate;
  setLocale: (locale: Locale) => void;
  /** True after switching between LTR and RTL: React Native applies layout direction only on next launch. */
  needsRestart: boolean;
  /** Translated, user-safe message for any thrown value. */
  describeError: (error: unknown) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

const ERROR_KEYS: Record<ApiError['kind'], MessageKey> = {
  offline: 'errOffline',
  timeout: 'errTimeout',
  cancelled: 'errCancelled',
  unauthorized: 'errUnauthorized',
  disabled: 'errDisabled',
  forbidden: 'errForbidden',
  not_found: 'errNotFound',
  conflict: 'errConflict',
  validation: 'errValidation',
  rate_limited: 'errRateLimited',
  quota: 'errQuota',
  server: 'errServer',
  unavailable: 'errUnavailable',
  invalid_response: 'errInvalidResponse',
  unknown: 'errUnknown',
};

export function errorMessageKey(error: unknown): MessageKey {
  return ApiError.is(error) ? ERROR_KEYS[error.kind] : 'errUnknown';
}

function deviceLocale(): Locale {
  try {
    return matchLocale(getLocales()[0]?.languageCode);
  } catch {
    return 'en';
  }
}

/** Applies layout direction. Returns true when a restart is required for it to take effect. */
function applyDirection(locale: Locale): boolean {
  const wantRtl = isRtl(locale);
  I18nManager.allowRTL(true);
  if (I18nManager.isRTL !== wantRtl) {
    I18nManager.forceRTL(wantRtl);
    return true;
  }
  return false;
}

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? deviceLocale());
  const [needsRestart, setNeedsRestart] = useState(false);

  useEffect(() => {
    if (initialLocale) return;
    let cancelled = false;
    void readPref('locale').then((saved) => {
      if (!cancelled && isLocale(saved)) {
        setLocaleState(saved);
        setNeedsRestart(applyDirection(saved));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialLocale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    setNeedsRestart(applyDirection(next));
    void writePref('locale', next);
  }, []);

  const value = useMemo<I18nValue>(() => {
    const t: Translate = (key, params) => translate(locale, key, params);
    return { locale, rtl: isRtl(locale), t, setLocale, needsRestart, describeError: (error) => t(errorMessageKey(error)) };
  }, [locale, needsRestart, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>.');
  return value;
}

export { LOCALES };
