import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { aiApi } from '../../api/endpoints/ai';
import { useServices } from '../../app/services';
import { formatDate, isolate } from '../../i18n/format';
import { useI18n } from '../../i18n/I18nProvider';
import type { AssistantStackParamList } from '../../navigation/AssistantStack';
import { MIN_TARGET, spacing } from '../../theme/theme';
import { AppText, Button, Card, Screen, StateView } from '../../ui/components';

type Nav = NativeStackNavigationProp<AssistantStackParamList, 'Conversations'>;

export function ConversationsScreen() {
  const { t, describeError, locale } = useI18n();
  const { client } = useServices();
  const navigation = useNavigation<Nav>();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['ai', 'conversations'], queryFn: ({ signal }) => aiApi.conversations(client, signal) });
  const remove = useMutation({
    mutationFn: (id: string) => aiApi.deleteConversation(client, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai', 'conversations'] }),
  });

  function confirmDelete(id: string) {
    Alert.alert(t('aiDeleteChat'), t('aiDeleteChatConfirm'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('aiDeleteChat'), style: 'destructive', onPress: () => remove.mutate(id) },
    ]);
  }

  return (
    <Screen padded={false}>
      <FlatList
        data={list.data ?? []}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, flexGrow: 1 }}
        ListEmptyComponent={
          list.isPending ? (
            <StateView kind="loading" title={t('loading')} />
          ) : list.isError ? (
            <StateView kind="error" title={describeError(list.error)} onRetry={() => void list.refetch()} />
          ) : (
            <StateView kind="empty" title={t('aiNoConversations')} />
          )
        }
        renderItem={({ item }) => (
          <Card style={{ gap: spacing.sm }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.title || t('aiUntitled')}
              onPress={() => navigation.navigate('Chat', { conversationId: item.id })}
              style={{ minHeight: MIN_TARGET, justifyContent: 'center' }}
            >
              <AppText style={{ fontWeight: '600' }} numberOfLines={1}>
                {isolate(item.title || t('aiUntitled'))}
              </AppText>
              <AppText variant="caption" muted>
                {formatDate(item.updatedAt, locale, true)}
              </AppText>
            </Pressable>
            <View>
              <Button
                label={t('aiDeleteChat')}
                variant="danger"
                onPress={() => confirmDelete(item.id)}
                busy={remove.isPending && remove.variables === item.id}
              />
            </View>
          </Card>
        )}
      />
    </Screen>
  );
}
