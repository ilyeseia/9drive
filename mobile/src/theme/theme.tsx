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
  danger: string;
  onDanger: string;
  success: string;
  warning: string;
  focus: string;
}

export const lightPalette: Palette = {
  background: '#F6F7FB',
  surface: '#FFFFFF',
  surfaceAlt: '#EEF0F6',
  border: '#D5D9E4',
  text: '#10131C',
  textMuted: '#4A5164',
  primary: '#3730C9',
  onPrimary: '#FFFFFF',
  danger: '#B3261E',
  onDanger: '#FFFFFF',
  success: '#1B6B3A',
  warning: '#8A5300',
  focus: '#3730C9',
};

export const darkPalette: Palette = {
  background: '#0B0E16',
  surface: '#141927',
  surfaceAlt: '#1D2333',
  border: '#2C3348',
  text: '#F1F3F9',
  textMuted: '#A8B0C5',
  primary: '#A9A5FF',
  onPrimary: '#0B0E16',
  danger: '#FF8A80',
  onDanger: '#1A0504',
  success: '#7FD6A0',
  warning: '#F2B35C',
  focus: '#A9A5FF',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;
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
