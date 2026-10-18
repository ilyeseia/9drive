import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { I18nProvider } from '../i18n/I18nProvider';
import { ThemeProvider, MIN_TARGET, contrastRatio, darkPalette, lightPalette } from '../theme/theme';
import { Button, StateView } from './components';

const wrap = (ui: ReactNode) => (
  <ThemeProvider initialMode="light">
    <I18nProvider initialLocale="en">{ui}</I18nProvider>
  </ThemeProvider>
);

describe('Button', () => {
  it('is an accessible button that fires onPress', async () => {
    const onPress = jest.fn();
    await render(wrap(<Button label="Save" onPress={onPress} />));
    const button = screen.getByRole('button', { name: 'Save' });
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire while busy or disabled and reports its state to assistive tech', async () => {
    const onPress = jest.fn();
    await render(
      wrap(
        <>
          <Button label="Busy" busy onPress={onPress} />
          <Button label="Off" disabled onPress={onPress} />
        </>,
      ),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Busy' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Off' }));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Busy' })).toBeBusy();
    expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled();
  });
});

describe('StateView', () => {
  it('announces an error and offers a working retry', async () => {
    const onRetry = jest.fn();
    await render(wrap(<StateView kind="error" title="Offline" message="Check your connection" onRetry={onRetry} />));
    expect(screen.getByRole('alert')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('design tokens', () => {
  it('meets WCAG AA contrast (4.5:1) for body text, muted text and filled buttons in both schemes', () => {
    for (const p of [lightPalette, darkPalette]) {
      expect(contrastRatio(p.text, p.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.textMuted, p.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.textMuted, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.onPrimary, p.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.onDanger, p.danger)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.danger, p.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.warning, p.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the minimum touch target at 48dp', () => {
    expect(MIN_TARGET).toBeGreaterThanOrEqual(48);
  });
});
