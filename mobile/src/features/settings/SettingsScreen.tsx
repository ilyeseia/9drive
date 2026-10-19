import { ScrollView, View } from 'react-native';
import Constants from 'expo-constants';
import { Screen, AppText } from '../../ui/components';
import { ScreenHeader, SectionCard, Segmented } from '../../ui/extra';
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
        <ScreenHeader title={t('settingsTitle')} />

        <AccountSection />

        <OfflineSection />

        <SectionCard icon="globe" title={t('language')} tone="accent">
          <Segmented options={LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] }))} value={locale} onChange={setLocale} />
          {needsRestart ? (
            <AppText variant="caption" accessibilityRole="alert" style={{ color: colors.warning }}>
              {t('restartForDirection')}
            </AppText>
          ) : null}
        </SectionCard>

        <SectionCard icon="sliders" title={t('theme')}>
          <Segmented options={MODES.map((entry) => ({ value: entry.mode, label: t(entry.key) }))} value={mode} onChange={setMode} />
        </SectionCard>

        <SectionCard icon="server" title={t('server')} tone="neutral">
          <View style={{ gap: spacing.xs }}>
            <AppText style={{ fontWeight: '600' }}>{isolate(host)}</AppText>
            {!isConfigError(config) && config.insecureTransport ? (
              <AppText variant="caption" style={{ color: colors.warning }}>
                {t('serverInsecure')}
              </AppText>
            ) : null}
            <AppText variant="caption" muted>
              {t('version')}: {Constants.expoConfig?.version ?? '—'}
            </AppText>
          </View>
        </SectionCard>
      </ScrollView>
    </Screen>
  );
}
