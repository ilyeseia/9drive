import { useRoute } from '@react-navigation/native';
import { Screen, StateView } from '../ui/components';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/messages';

const TITLES: Record<string, MessageKey> = { Files: 'tabFiles', Storage: 'tabStorage', Assistant: 'tabAssistant' };

/** Honest stand-in for a section that is not built yet (replaced phase by phase). No fake controls. */
export function PlaceholderScreen() {
  const { t } = useI18n();
  const route = useRoute();
  const titleKey = TITLES[route.name];
  return (
    <Screen>
      <StateView kind="empty" title={titleKey ? t(titleKey) : t('emptyTitle')} message={t('notAvailableYet')} />
    </Screen>
  );
}
