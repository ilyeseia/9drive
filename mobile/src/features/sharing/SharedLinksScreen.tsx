import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { bytesToNumber } from '../../api/schemas';
import { formatBytes, formatDate, isolate } from '../../i18n/format';
import { useI18n } from '../../i18n/I18nProvider';
import type { FilesStackParamList } from '../../navigation/FilesStack';
import { spacing } from '../../theme/theme';
import { AppText, Card, Screen, StateView } from '../../ui/components';
import { useShares } from './queries';

type Nav = NativeStackNavigationProp<FilesStackParamList, 'SharedLinks'>;

/** Active public links across the user's files. Links themselves are never shown here (the server keeps only a hash). */
export function SharedLinksScreen() {
  const { t, describeError, locale } = useI18n();
  const navigation = useNavigation<Nav>();
  const shares = useShares();
  return (
    <Screen padded={false}>
      <FlatList
        data={shares.data ?? []}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={shares.isRefetching} onRefresh={() => void shares.refetch()} />}
        ListEmptyComponent={
          shares.isPending ? (
            <StateView kind="loading" title={t('loading')} />
          ) : shares.isError ? (
            <StateView kind="error" title={describeError(shares.error)} onRetry={() => void shares.refetch()} />
          ) : (
            <StateView kind="empty" title={t('sharedEmpty')} />
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={item.file.name}
            onPress={() => navigation.navigate('FileDetails', { fileId: item.file.id })}
          >
            <Card style={{ gap: spacing.xs }}>
              <AppText style={{ fontWeight: '600' }} numberOfLines={1}>
                {isolate(item.file.name)}
              </AppText>
              <View>
                <AppText variant="caption" muted>
                  {`${formatBytes(bytesToNumber(item.file.sizeBytes), locale)} · ${t('sharedCreatedOn', { date: formatDate(item.createdAt, locale) })}`}
                </AppText>
                <AppText variant="caption" muted>
                  {t('shareExpires', { date: formatDate(item.expiresAt, locale) })}
                </AppText>
              </View>
            </Card>
          </Pressable>
        )}
      />
    </Screen>
  );
}
