import { FlatList, View } from 'react-native';
import { useServices, useTransfers } from '../../app/services';
import { errorMessageKey, useI18n } from '../../i18n/I18nProvider';
import { formatBytes, isolate } from '../../i18n/format';
import type { MessageKey } from '../../i18n/messages';
import { ApiError, type ApiErrorKind } from '../../api/errors';
import { spacing, useTheme } from '../../theme/theme';
import { progressFraction, type TransferItem, type TransferStatus } from '../../transfers/manager';
import { AppText, Button, Card, Screen, StateView } from '../../ui/components';
import { ProgressBar } from '../../ui/extra';

const STATUS_KEY: Record<TransferStatus, MessageKey> = {
  queued: 'transferQueued',
  active: 'transferActive',
  paused: 'transferPaused',
  completed: 'transferCompleted',
  failed: 'transferFailed',
  cancelled: 'transferCancelled',
};

export function TransfersScreen() {
  const { t, locale } = useI18n();
  const { colors } = useTheme();
  const { transfers } = useServices();
  const items = useTransfers();
  const finished = items.some((i) => i.status === 'completed' || i.status === 'cancelled');

  return (
    <Screen padded={false}>
      <FlatList
        data={[...items].reverse()}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, flexGrow: 1 }}
        ListHeaderComponent={
          <View style={{ gap: spacing.sm }}>
            <AppText variant="caption" muted>
              {t('transfersOnlyConfirmed')}
            </AppText>
            {finished ? <Button label={t('clearFinished')} variant="secondary" onPress={() => transfers.clearFinished()} /> : null}
          </View>
        }
        ListEmptyComponent={<StateView kind="empty" title={t('transfersEmpty')} />}
        renderItem={({ item }) => (
          <TransferRow
            item={item}
            locale={locale}
            onCancel={() => transfers.cancel(item.id)}
            onRetry={() => transfers.retry(item.id)}
            onDismiss={() => transfers.dismiss(item.id)}
            danger={colors.danger}
          />
        )}
      />
    </Screen>
  );
}

function TransferRow({
  item,
  locale,
  onCancel,
  onRetry,
  onDismiss,
  danger,
}: {
  item: TransferItem;
  locale: 'en' | 'ar' | 'fr';
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  danger: string;
}) {
  const { t } = useI18n();
  const running = item.status === 'active' || item.status === 'queued';
  const errorText =
    item.status === 'failed'
      ? t(errorMessageKey(new ApiError((item.errorKind ?? 'unknown') as ApiErrorKind, null, item.errorCode, '')))
      : null;
  return (
    <Card style={{ gap: spacing.sm }}>
      <AppText style={{ fontWeight: '600' }} numberOfLines={1}>
        {isolate(item.name)}
      </AppText>
      <AppText variant="caption" muted>
        {`${t(item.kind === 'upload' ? 'uploadingLabel' : 'downloadingLabel')} · ${t(STATUS_KEY[item.status])}`}
      </AppText>
      {item.status === 'active' || item.status === 'paused' || item.status === 'queued' ? (
        <>
          <ProgressBar fraction={progressFraction(item)} label={item.name} />
          <AppText variant="caption" muted>
            {t('progressOf', { sent: formatBytes(item.sent, locale), total: formatBytes(item.total, locale) })}
          </AppText>
        </>
      ) : null}
      {errorText ? (
        <AppText variant="caption" accessibilityRole="alert" style={{ color: danger }}>
          {errorText}
        </AppText>
      ) : null}
      {item.status === 'failed' && item.errorDetail ? (
        <AppText variant="caption" muted selectable>
          {item.errorDetail}
        </AppText>
      ) : null}
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        {running ? <Button label={t('cancel')} variant="secondary" onPress={onCancel} style={{ flex: 1 }} /> : null}
        {item.status === 'failed' || item.status === 'paused' || item.status === 'cancelled' ? (
          <Button label={t('resume')} onPress={onRetry} style={{ flex: 1 }} />
        ) : null}
        {!running ? <Button label={t('dismiss')} variant="secondary" onPress={onDismiss} style={{ flex: 1 }} /> : null}
      </View>
    </Card>
  );
}
