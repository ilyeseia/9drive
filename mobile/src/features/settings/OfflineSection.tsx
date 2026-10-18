import { useEffect, useSyncExternalStore } from 'react';
import { loadOfflineSetting, offlineSettingStore, saveOfflineSetting } from '../../core/offlineCache';
import { useI18n } from '../../i18n/I18nProvider';
import { spacing } from '../../theme/theme';
import { AppText, Button, Card } from '../../ui/components';

/** Opt-in switch for the offline copy. States plainly what is stored and what still needs a connection. */
export function OfflineSection() {
  const { t } = useI18n();
  const enabled = useSyncExternalStore(offlineSettingStore.subscribe, offlineSettingStore.get, offlineSettingStore.get);

  useEffect(() => {
    void loadOfflineSetting();
  }, []);

  return (
    <Card style={{ gap: spacing.md }}>
      <AppText variant="heading">{t('offlineTitle')}</AppText>
      <AppText variant="caption" muted>
        {t('offlineBody')}
      </AppText>
      <AppText variant="caption" muted>
        {t('offlineWorks')}
      </AppText>
      <Button
        label={t(enabled ? 'offlineDisable' : 'offlineEnable')}
        variant={enabled ? 'danger' : 'secondary'}
        onPress={() => void saveOfflineSetting(!enabled)}
      />
    </Card>
  );
}
