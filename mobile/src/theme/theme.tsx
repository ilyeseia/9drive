import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { readPref, writePref } from '../core/prefs';

/**
 * Design tokens. Colours are chosen for WCAG AA contrast (>= 4.5:1 for body text) in both schemes;
 * `colors.test.ts` computes the ratios so a future palette change cannot silently regress them.
 */

export interface Palette {
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  /** Secondary brand colour, used for decorative accents and highlights (never as the only carrier of meaning). */
  accent: string;
  danger: string;
  onDanger: string;
  success: string;
  warning: string;
  focus: string;
}

export const lightPalette: Palette = {
  background: '#F3F5FF',
  surface: '#FFFFFF',
  surfaceAlt: '#E8ECFB',
  border: '#D2D9F1',
  text: '#0D1230',
  textMuted: '#454E6E',
  primary: '#3B47D8',
  onPrimary: '#FFFFFF',
  accent: '#0F8F80',
  danger: '#B3261E',
  onDanger: '#FFFFFF',
  success: '#1B6B3A',
  warning: '#8A5300',
  focus: '#3B47D8',
};

export const darkPalette: Palette = {
  background: '#090C19',
  surface: '#121A2F',
  surfaceAlt: '#1B2542',
  border: '#2A3558',
  text: '#F2F5FF',
  textMuted: '#A9B4D3',
  primary: '#8C97FF',
  onPrimary: '#090C19',
  accent: '#3DD9C5',
  danger: '#FF8A80',
  onDanger: '#1A0504',
  success: '#7FD6A0',
  warning: '#F2B35C',
  focus: '#8C97FF',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

/** Cross-platform soft shadow (iOS shadow* props, Android elevation). Level 0 is flat. */
export function elevation(level: 0 | 1 | 2 | 3): {
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  elevation: number;
} {
  const table = [
    { o: 0, r: 0, y: 0, e: 0 },
    { o: 0.1, r: 6, y: 2, e: 2 },
    { o: 0.16, r: 12, y: 5, e: 5 },
    { o: 0.22, r: 20, y: 9, e: 9 },
  ] as const;
  const { o, r, y, e } = table[level];
  return { shadowColor: '#000000', shadowOpacity: o, shadowRadius: r, shadowOffset: { width: 0, height: y }, elevation: e };
}
/** Minimum touch target (dp): 48 satisfies both Android (48) and iOS (44) guidance. */
export const MIN_TARGET = 48;

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  scheme: 'light' | 'dark';
  colors: Palette;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function isMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function ThemeProvider({ children, initialMode }: { children: ReactNode; initialMode?: ThemeMode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>(initialMode ?? 'system');

  useEffect(() => {
    if (initialMode) return;
    let cancelled = false;
    void readPref('theme').then((saved) => {
      if (!cancelled && isMode(saved)) setModeState(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [initialMode]);

  const value = useMemo<ThemeValue>(() => {
    const scheme: 'light' | 'dark' = mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;
    return {
      mode,
      scheme,
      colors: scheme === 'dark' ? darkPalette : lightPalette,
      setMode: (next) => {
        setModeState(next);
        void writePref('theme', next);
      },
    };
  }, [mode, system]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return value;
}

/** WCAG relative-luminance contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const channel = (i: number) => {
      const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
