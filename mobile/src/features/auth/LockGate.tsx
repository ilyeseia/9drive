import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AppState, View } from 'react-native';
import { useLockState, useServices } from '../../app/services';
import { useI18n } from '../../i18n/I18nProvider';
import { spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Screen } from '../../ui/components';

const TICK_MS = 5_000;

/**
 * Wraps the signed-in app with the optional app lock.
 *
 * - While locked, an opaque screen covers the content and the content is hidden from screen readers
 *   (the navigation tree stays mounted so the user returns to where they were).
 * - While the app is not in the foreground, a cover hides the content so the app-switcher snapshot
 *   (iOS "inactive" state, Android recents) does not show file names.
 * - Touches are observed (not consumed) to drive the inactivity timeout.
 */
export function LockGate({ children, onSignOut }: { children: ReactNode; onSignOut: () => void }) {
  const { lock } = useServices();
  const state = useLockState();
  const { t } = useI18n();
  const { colors } = useTheme();
  const [appState, setAppState] = useState(AppState.currentState);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void lock.init();
  }, [lock]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setAppState(next);
      if (next === 'active') lock.onForeground();
      else lock.onBackground();
    });
    const timer = setInterval(() => lock.tick(), TICK_MS);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [lock]);

  const unlock = useCallback(() => {
    setFailed(false);
    void lock.unlock({ title: t('unlockPrompt'), cancel: t('cancel') }).then((ok) => setFailed(!ok));
  }, [lock, t]);

  // Offer the prompt automatically whenever the app becomes locked and visible.
  useEffect(() => {
    if (state.locked && appState === 'active') {
      void lock.unlock({ title: t('unlockPrompt'), cancel: t('cancel') }).then((ok) => setFailed(!ok));
    }
  }, [state.locked, appState, lock, t]);

  const covered = state.settings.enabled && appState !== 'active';

  return (
    <View style={{ flex: 1 }} onTouchStart={() => lock.touch()}>
      <View
        style={{ flex: 1 }}
        importantForAccessibility={state.locked ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={state.locked}
      >
        {children}
      </View>
      {state.locked ? (
        <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.background }}>
          <Screen>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg }}>
              <AppText variant="title" accessibilityRole="header" style={{ textAlign: 'center' }}>
                {t('lockedTitle')}
              </AppText>
              <AppText muted style={{ textAlign: 'center' }}>
                {t('lockedBody')}
              </AppText>
              {failed ? (
                <AppText accessibilityRole="alert" style={{ color: colors.danger, textAlign: 'center' }}>
                  {t('lockFailed')}
                </AppText>
              ) : null}
              <Button label={t('unlock')} onPress={unlock} />
              <AppText variant="caption" muted style={{ textAlign: 'center' }}>
                {t('lockedSignOutHint')}
              </AppText>
              <Button label={t('signOut')} variant="secondary" onPress={onSignOut} />
            </View>
          </Screen>
        </View>
      ) : covered ? (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.background }}
        />
      ) : null}
    </View>
  );
}
