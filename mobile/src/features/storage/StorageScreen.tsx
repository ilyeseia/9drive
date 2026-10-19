import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useEffect } from 'react';
import { Alert, AppState, FlatList, RefreshControl, Switch, View } from 'react-native';
import type { AccountView } from '../../api/endpoints/providers';
import { describeErrorDetail } from '../../core/errorDetail';
import { useI18n } from '../../i18n/I18nProvider';
import { formatBytes, formatDate, isolate } from '../../i18n/format';
import type { StorageStackParamList } from '../../navigation/StorageStack';
import { spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card, Screen, StateView } from '../../ui/components';
import { IconTile, Pill, ProgressBar, ScreenHeader, type Tone } from '../../ui/extra';
import { FreshnessNote } from '../../ui/Offline';
import { healthSeverity, providerLabel, quotaOf, statusSeverity, summarize, type Severity } from './model';
import { useAccounts, useCatalog, useStorageActions } from './queries';

type Nav = NativeStackNavigationProp<StorageStackParamList, 'StorageList'>;

export function StorageScreen() {
  const { t, describeError, locale } = useI18n();
  const navigation = useNavigation<Nav>();
  const accounts = useAccounts();
  const catalog = useCatalog();
  const list = accounts.data ?? [];
  const { refetch } = accounts;
  // A sign-in finished in the browser (or a change made on the web) shows up as soon as the user returns.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refetch();
    });
    return () => subscription.remove();
  }, [refetch]);
  const summary = summarize(list);

  return (
    <Screen padded={false}>
      <FlatList
        data={list}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={accounts.isRefetching} onRefresh={() => void accounts.refetch()} />}
        ListHeaderComponent={
          <View style={{ gap: spacing.md, paddingBottom: spacing.sm }}>
            <ScreenHeader title={t('storageTitle')} />
            <FreshnessNote updatedAt={accounts.dataUpdatedAt} stale={accounts.isError || accounts.fetchStatus === 'paused'} />
            {summary.counted > 0 ? (
              <Card style={{ gap: spacing.sm, padding: spacing.xl }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                  <IconTile icon="cloud" tone="primary" size={48} />
                  <AppText style={{ fontWeight: '800', fontSize: 17, flex: 1 }}>
                    {t('storageSummary', { used: formatBytes(summary.used, locale), total: formatBytes(summary.total, locale) })}
                  </AppText>
                </View>
                <ProgressBar fraction={summary.total > 0 ? summary.used / summary.total : 0} label={t('storageTitle')} />
                {summary.skipped > 0 ? (
                  <AppText variant="caption" muted>
                    {t('storageSummarySkipped', { count: summary.skipped })}
                  </AppText>
                ) : null}
              </Card>
            ) : null}
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Button
                label={t('routing')}
                variant="secondary"
                icon="sliders"
                compact
                onPress={() => navigation.navigate('Routing')}
                style={{ flex: 1 }}
              />
              <Button label={t('addAccount')} icon="plus" compact onPress={() => navigation.navigate('AddAccount')} style={{ flex: 1 }} />
            </View>
          </View>
        }
        ListEmptyComponent={
          accounts.isPending ? (
            <StateView kind="loading" title={t('loading')} />
          ) : accounts.isError ? (
            <StateView
              kind="error"
              title={describeError(accounts.error)}
              message={describeErrorDetail(accounts.error)}
              onRetry={() => void accounts.refetch()}
            />
          ) : (
            <StateView
              kind="empty"
              title={t('storageEmpty')}
              message={t('storageEmptyHelp')}
              action={{ label: t('addAccount'), onPress: () => navigation.navigate('AddAccount') }}
            />
          )
        }
        renderItem={({ item }) => <AccountCard account={item} label={providerLabel(item.provider, catalog.data)} />}
      />
    </Screen>
  );
}

const SEVERITY_TONE: Record<Severity, Tone> = { ok: 'success', bad: 'danger', warn: 'warning', unknown: 'neutral' };

const SEVERITY_COLOR = (severity: Severity, c: ReturnType<typeof useTheme>['colors']) =>
  severity === 'ok' ? c.success : severity === 'bad' ? c.danger : severity === 'warn' ? c.warning : c.textMuted;

function AccountCard({ account, label }: { account: AccountView; label: string }) {
  const { t, describeError, locale } = useI18n();
  const { colors } = useTheme();
  const actions = useStorageActions();
  const quota = quotaOf(account);
  const name = account.displayName?.trim() || account.email;
  const statusSev = statusSeverity(account.status);
  const healthSev = healthSeverity(account.health?.state);
  const busy =
    actions.checkHealth.isPending || actions.refreshQuota.isPending || actions.setRouting.isPending || actions.disconnect.isPending;
  const error = actions.checkHealth.error ?? actions.refreshQuota.error ?? actions.setRouting.error ?? actions.disconnect.error;

  const quotaText =
    quota.kind === 'unknown'
      ? t('quotaUnknown')
      : quota.kind === 'usedOnly'
        ? t('quotaUsedOnly', { used: formatBytes(quota.used, locale) })
        : t('quotaKnown', {
            used: formatBytes(quota.used, locale),
            total: formatBytes(quota.total, locale),
            available: formatBytes(quota.available, locale),
          });

  function confirmDisconnect() {
    Alert.alert(t('disconnectConfirmTitle'), t('disconnectConfirmBody', { name }), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('disconnect'), style: 'destructive', onPress: () => actions.disconnect.mutate(account.id) },
    ]);
  }

  const statusText =
    account.status === 'connected'
      ? t('statusConnected')
      : statusSev === 'bad'
        ? t('statusError')
        : t('statusOther', { status: account.status });
  const routingValue = account.routingEnabled ?? !account.experimental;

  return (
    <Card style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <IconTile icon="cloud" tone={SEVERITY_TONE[statusSev]} size={44} />
        <View style={{ flex: 1 }}>
          <AppText style={{ fontWeight: '800' }} numberOfLines={1}>
            {isolate(name)}
          </AppText>
          <AppText variant="caption" muted numberOfLines={1}>
            {label}
            {account.experimental ? ` · ${t('experimentalBadge')}` : ''}
          </AppText>
        </View>
        <Pill label={statusText} tone={SEVERITY_TONE[statusSev]} />
      </View>

      {quota.kind === 'known' ? <ProgressBar fraction={quota.fraction} label={name} /> : null}
      <AppText variant="caption" muted>
        {quotaText}
      </AppText>
      <AppText variant="caption" muted>
        {account.lastSyncedAt ? t('lastSynced', { date: formatDate(account.lastSyncedAt, locale, true) }) : t('neverSynced')}
      </AppText>

      <AppText variant="caption" style={{ color: SEVERITY_COLOR(healthSev, colors) }}>
        {`${t('healthLabel')}: `}
        {account.health ? t('healthState', { state: account.health.state, ms: account.health.latencyMs ?? '—' }) : t('healthUnknown')}
      </AppText>
      {account.lastError ? (
        <AppText variant="caption" style={{ color: colors.danger }} numberOfLines={2}>
          {account.lastError}
        </AppText>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <View style={{ flex: 1 }}>
          <AppText variant="label">{t('useForUploads')}</AppText>
          <AppText variant="caption" muted>
            {t('useForUploadsHelp')}
          </AppText>
        </View>
        <Switch
          accessibilityLabel={t('useForUploads')}
          value={routingValue}
          disabled={busy}
          onValueChange={(enabled) => actions.setRouting.mutate({ id: account.id, enabled })}
          trackColor={{ true: colors.primary, false: colors.border }}
        />
      </View>

      {account.capabilities.length > 0 ? (
        <AppText variant="caption" muted>
          {`${t('capabilities')}: ${account.capabilities.join(', ')}`}
        </AppText>
      ) : null}

      {error ? (
        <AppText variant="caption" accessibilityRole="alert" style={{ color: colors.danger }}>
          {describeError(error)}
        </AppText>
      ) : null}

      <View style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button
            compact
            label={t('checkHealth')}
            variant="secondary"
            busy={actions.checkHealth.isPending}
            onPress={() => actions.checkHealth.mutate(account.id)}
            style={{ flex: 1 }}
          />
          <Button
            compact
            label={t('refreshQuota')}
            variant="secondary"
            busy={actions.refreshQuota.isPending}
            onPress={() => actions.refreshQuota.mutate(account.id)}
            style={{ flex: 1 }}
          />
        </View>
        <Button label={t('disconnect')} variant="danger" compact busy={actions.disconnect.isPending} onPress={confirmDisconnect} />
      </View>
    </Card>
  );
}
