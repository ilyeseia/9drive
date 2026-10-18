import { ScrollView, View } from 'react-native';
import Constants from 'expo-constants';
import { Screen, AppText, Button, Card } from '../../ui/components';
import { useI18n } from '../../i18n/I18nProvider';
import { LOCALES, LOCALE_NAMES } from '../../i18n/messages';
import { useTheme, spacing, type ThemeMode } from '../../theme/theme';
import { loadConfig, isConfigError } from '../../config/env';
import { isolate } from '../../i18n/format';
import { AccountSection } from './AccountSection';
import { OfflineSection } from './OfflineSection';

const MODES: { mode: ThemeMode; key: 'themeSystem' | 'themeLight' | 'themeDark' }[] = [
  { mode: 'system', key: 'themeSystem' },
  { mode: 'light', key: 'themeLight' },
  { mode: 'dark', key: 'themeDark' },
];

export function SettingsScreen() {
  const { t, locale, setLocale, needsRestart } = useI18n();
  const { mode, setMode, colors } = useTheme();
  const config = loadConfig();
  let host = '—';
  if (!isConfigError(config)) {
    try {
      host = new URL(config.apiBaseUrl).host;
    } catch {
      host = '—';
    }
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <AppText variant="title" accessibilityRole="header">
          {t('settingsTitle')}
        </AppText>

        <AccountSection />

        <OfflineSection />

        <Card style={{ gap: spacing.md }}>
          <AppText variant="heading">{t('language')}</AppText>
          <View style={{ gap: spacing.sm }}>
            {LOCALES.map((code) => (
              <Button
                key={code}
                label={LOCALE_NAMES[code]}
                variant={code === locale ? 'primary' : 'secondary'}
                onPress={() => setLocale(code)}
                accessibilityHint={code === locale ? undefined : LOCALE_NAMES[code]}
              />
            ))}
          </View>
          {needsRestart ? (
            <AppText variant="caption" accessibilityRole="alert" style={{ color: colors.warning }}>
              {t('restartForDirection')}
            </AppText>
          ) : null}
        </Card>

        <Card style={{ gap: spacing.md }}>
          <AppText variant="heading">{t('theme')}</AppText>
          <View style={{ gap: spacing.sm }}>
            {MODES.map((entry) => (
              <Button
                key={entry.mode}
                label={t(entry.key)}
                variant={entry.mode === mode ? 'primary' : 'secondary'}
                onPress={() => setMode(entry.mode)}
              />
            ))}
          </View>
        </Card>

        <Card style={{ gap: spacing.xs }}>
          <AppText variant="heading">{t('server')}</AppText>
          <AppText muted>{isolate(host)}</AppText>
          {!isConfigError(config) && config.insecureTransport ? (
            <AppText variant="caption" style={{ color: colors.warning }}>
              {t('serverInsecure')}
            </AppText>
          ) : null}
          <AppText variant="caption" muted>
            {t('version')}: {Constants.expoConfig?.version ?? '—'}
          </AppText>
        </Card>
      </ScrollView>
    </Screen>
  );
}
