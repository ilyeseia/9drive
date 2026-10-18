import { View } from 'react-native';
import { useOnline } from '../core/network';
import { formatDate } from '../i18n/format';
import { useI18n } from '../i18n/I18nProvider';
import { spacing, useTheme } from '../theme/theme';
import { AppText } from './components';

/** Shown across the app while the device has no connection. Never hides the fact that data may be stale. */
export function OfflineBanner() {
  const online = useOnline();
  const { t } = useI18n();
  const { colors } = useTheme();
  if (online) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ backgroundColor: colors.surfaceAlt, padding: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.warning }}
    >
      <AppText variant="caption" style={{ color: colors.warning, textAlign: 'center' }}>
        {t('offlineBanner')}
      </AppText>
    </View>
  );
}

/**
 * Distinguishes a saved copy from live data: shown when the list is not being served fresh from the server
 * (offline, or the last refresh failed) so the user knows how old what they see is.
 */
export function FreshnessNote({ updatedAt, stale }: { updatedAt: number; stale: boolean }) {
  const { t, locale } = useI18n();
  const online = useOnline();
  if (!stale && online) return null;
  if (!updatedAt) return null;
  return (
    <AppText variant="caption" muted>
      {t('cachedFrom', { date: formatDate(new Date(updatedAt).toISOString(), locale, true) })}
    </AppText>
  );
}
