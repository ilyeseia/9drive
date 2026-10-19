import { useEffect, useSyncExternalStore } from 'react';
import { loadOfflineSetting, offlineSettingStore, saveOfflineSetting } from '../../core/offlineCache';
import { useI18n } from '../../i18n/I18nProvider';
import { AppText, Button } from '../../ui/components';
import { SectionCard } from '../../ui/extra';

/** Opt-in switch for the offline copy. States plainly what is stored and what still needs a connection. */
export function OfflineSection() {
  const { t } = useI18n();
  const enabled = useSyncExternalStore(offlineSettingStore.subscribe, offlineSettingStore.get, offlineSettingStore.get);

  useEffect(() => {
    void loadOfflineSetting();
  }, []);

  return (
    <SectionCard icon="download" title={t('offlineTitle')} tone="accent">
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
    </SectionCard>
  );
}
