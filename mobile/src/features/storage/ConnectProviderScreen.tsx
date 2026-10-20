import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, ScrollView, View } from 'react-native';
import { ApiError } from '../../api/errors';
import type { CatalogEntry } from '../../api/endpoints/providers';
import { describeErrorDetail } from '../../core/errorDetail';
import { ExternalUrlError, openProviderSignIn } from '../../core/externalLink';
import { useI18n } from '../../i18n/I18nProvider';
import type { StorageStackParamList } from '../../navigation/StorageStack';
import { radius, spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card, Screen, StateView } from '../../ui/components';
import { IconTile, type Tone } from '../../ui/extra';
import { Icon, type IconName } from '../../ui/Icon';
import { providerLabel } from './model';
import { useAccounts, useCatalog, useStorageActions } from './queries';

type Nav = NativeStackNavigationProp<StorageStackParamList, 'AddAccount'>;

/** Providers the app can connect itself: a browser sign-in (OAuth2 redirect) or S3-compatible access keys. */
export function connectableProviders(catalog: CatalogEntry[]): {
  oauth: CatalogEntry[];
  s3: boolean;
  teraboxOfficial: boolean;
  teraboxExperimental: boolean;
} {
  const oauth = catalog.filter(
    (entry) => entry.status === 'SUPPORTED' && entry.authMode === 'oauth2' && entry.connectMode !== 'device_code' && !entry.experimental,
  );
  const s3 = catalog.some((entry) => entry.id === 's3' && entry.status === 'SUPPORTED');
  const teraboxOfficial = catalog.some(
    (entry) => entry.id === 'terabox_open' && entry.status === 'SUPPORTED' && entry.connectMode === 'device_code',
  );
  const teraboxExperimental = catalog.some(
    (entry) => entry.id === 'terabox' && entry.status === 'SUPPORTED' && entry.authMode === 'api_key',
  );
  return { oauth, s3, teraboxOfficial, teraboxExperimental };
}

/**
 * Entry point for adding storage. OAuth providers open the system browser on the URL the server issues (the server
 * keeps the client secret and completes the sign-in); the app never sees provider tokens. When the user returns,
 * the account list is refreshed automatically.
 */
export function ConnectProviderScreen() {
  const { t, describeError } = useI18n();
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();
  const catalog = useCatalog();
  const accounts = useAccounts();
  // `refetch` is referentially stable; depending on the whole query object would re-run these effects every render.
  const { refetch } = accounts;
  const actions = useStorageActions();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ provider: string; text: string; detail: string } | null>(null);
  const [launched, setLaunched] = useState<string | null>(null);

  // Coming back from the browser: refresh so the new account shows up without any manual step.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && launched) void refetch();
    });
    return () => subscription.remove();
  }, [launched, refetch]);

  useFocusEffect(
    useCallback(() => {
      if (launched) void refetch();
    }, [launched, refetch]),
  );

  async function connectOauth(entry: CatalogEntry) {
    setError(null);
    setPending(entry.id);
    try {
      const { url } = await actions.connectUrl.mutateAsync(entry.id);
      await openProviderSignIn(url);
      setLaunched(entry.id);
    } catch (e) {
      const notConfigured = ApiError.is(e) && e.code === 'PROVIDER_NOT_AVAILABLE';
      setError({
        provider: entry.id,
        text: notConfigured
          ? t('connectNotConfigured', { provider: entry.displayName })
          : e instanceof ExternalUrlError
            ? t('errInvalidResponse')
            : describeError(e),
        detail: describeErrorDetail(e),
      });
    } finally {
      setPending(null);
    }
  }

  if (catalog.isPending) {
    return (
      <Screen>
        <StateView kind="loading" title={t('loading')} />
      </Screen>
    );
  }
  if (catalog.isError) {
    return (
      <Screen>
        <StateView
          kind="error"
          title={describeError(catalog.error)}
          message={describeErrorDetail(catalog.error)}
          onRetry={() => void catalog.refetch()}
        />
      </Screen>
    );
  }

  const { oauth, s3, teraboxOfficial, teraboxExperimental } = connectableProviders(catalog.data);
  const connectedIds = new Set((accounts.data ?? []).map((a) => a.provider));

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
        <AppText variant="heading" accessibilityRole="header">
          {t('connectTitle')}
        </AppText>
        <AppText muted>{t('connectIntro')}</AppText>

        {launched ? (
          <Card style={{ gap: spacing.sm, borderColor: colors.primary }}>
            <AppText accessibilityRole="alert" style={{ fontWeight: '700' }}>
              {t('connectWaiting', { provider: providerLabel(launched, catalog.data) })}
            </AppText>
            <AppText variant="caption" muted>
              {t('connectWaitingHelp')}
            </AppText>
            <Button
              label={t('connectDone')}
              icon="check"
              busy={accounts.isFetching}
              onPress={() => {
                void accounts.refetch().then((result) => {
                  if (result.data?.some((a) => a.provider === launched)) navigation.popToTop();
                });
              }}
            />
          </Card>
        ) : null}

        {oauth.map((entry) => (
          <Pressable
            key={entry.id}
            accessibilityRole="button"
            accessibilityLabel={t('connectWith', { provider: entry.displayName })}
            disabled={pending !== null}
            onPress={() => void connectOauth(entry)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              padding: spacing.md,
              minHeight: 68,
              borderRadius: radius.xl,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
              opacity: pending !== null && pending !== entry.id ? 0.5 : pressed ? 0.9 : 1,
            })}
          >
            <IconTile icon="cloud" tone="primary" size={44} />
            <View style={{ flex: 1 }}>
              <AppText style={{ fontWeight: '800' }}>{entry.displayName}</AppText>
              <AppText variant="caption" muted>
                {connectedIds.has(entry.id) ? t('connectAnother') : t('connectBrowserSignIn')}
              </AppText>
            </View>
            {pending === entry.id ? <AppText variant="caption">…</AppText> : <Icon name="chevron" size={20} color={colors.textMuted} />}
          </Pressable>
        ))}

        {error ? (
          <Card style={{ borderColor: colors.danger, gap: spacing.xs }}>
            <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
              {error.text}
            </AppText>
            <AppText variant="caption" muted selectable>
              {error.detail}
            </AppText>
          </Card>
        ) : null}

        {teraboxOfficial ? (
          <ProviderCard
            icon="cloud"
            tone="primary"
            title={t('teraboxOfficialName')}
            subtitle={connectedIds.has('terabox_open') ? t('connectAnother') : t('teraboxOfficialHelp')}
            label={t('connectWith', { provider: t('teraboxOfficialName') })}
            onPress={() => navigation.navigate('ConnectTeraBox')}
          />
        ) : null}
        {teraboxExperimental ? (
          <ProviderCard
            icon="alert"
            tone="warning"
            title={t('teraboxExperimentalName')}
            subtitle={connectedIds.has('terabox') ? t('connectAnother') : t('teraboxExperimentalHelp')}
            label={t('connectWith', { provider: t('teraboxExperimentalName') })}
            onPress={() => navigation.navigate('ConnectTeraBoxLogin')}
          />
        ) : null}

        {s3 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('connectS3')}
            onPress={() => navigation.navigate('ConnectS3')}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              padding: spacing.md,
              minHeight: 68,
              borderRadius: radius.xl,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.border,
              opacity: pressed ? 0.9 : 1,
            })}
          >
            <IconTile icon="server" tone="accent" size={44} />
            <View style={{ flex: 1 }}>
              <AppText style={{ fontWeight: '800' }}>{t('connectS3')}</AppText>
              <AppText variant="caption" muted>
                {t('connectS3Help')}
              </AppText>
            </View>
            <Icon name="chevron" size={20} color={colors.textMuted} />
          </Pressable>
        ) : null}

        <Card>
          <AppText variant="caption" muted>
            {t('connectOthersWeb')}
          </AppText>
        </Card>
      </ScrollView>
    </Screen>
  );
}

function ProviderCard({
  icon,
  tone,
  title,
  subtitle,
  label,
  onPress,
}: {
  icon: IconName;
  tone: Tone;
  title: string;
  subtitle: string;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.md,
        minHeight: 68,
        borderRadius: radius.xl,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <IconTile icon={icon} tone={tone} size={44} />
      <View style={{ flex: 1 }}>
        <AppText style={{ fontWeight: '800' }}>{title}</AppText>
        <AppText variant="caption" muted>
          {subtitle}
        </AppText>
      </View>
      <Icon name="chevron" size={20} color={colors.textMuted} />
    </Pressable>
  );
}
