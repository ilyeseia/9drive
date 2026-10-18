import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { aiApi, humanizeTool, aiErrorKey, type ChatMessage, type StepDto, type TaskStatus } from '../../api/endpoints/ai';
import { useServices } from '../../app/services';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/messages';
import type { AssistantStackParamList } from '../../navigation/AssistantStack';
import { MIN_TARGET, radius, spacing, useTheme } from '../../theme/theme';
import { AppText, Button, Card, Screen, StateView } from '../../ui/components';
import { Markdown } from '../../ui/Markdown';
import { ConfirmationCard } from './ConfirmationCard';
import { useAssistantChat } from './useChat';

type Nav = NativeStackNavigationProp<AssistantStackParamList, 'Chat'>;

const STATUS_KEY: Record<TaskStatus, MessageKey> = {
  RECEIVED: 'aiStatusReceived',
  ANALYZING: 'aiStatusAnalyzing',
  EXECUTING: 'aiStatusExecuting',
  VERIFYING: 'aiStatusVerifying',
  AWAITING_CONFIRMATION: 'aiStatusAwaiting',
  AWAITING_CLARIFICATION: 'aiStatusClarify',
  COMPLETED: 'aiStatusCompleted',
  PARTIALLY_COMPLETED: 'aiStatusPartial',
  FAILED: 'aiStatusFailed',
  CANCELLED: 'aiStatusCancelled',
};
const STEP_KEY: Record<StepDto['status'], MessageKey> = {
  SUCCEEDED: 'aiStepDone',
  FAILED: 'aiStepFailed',
  REJECTED: 'aiStepRejected',
  PENDING_CONFIRMATION: 'aiStepPending',
  SKIPPED: 'aiStepSkipped',
};
const EXAMPLES: MessageKey[] = ['aiExample1', 'aiExample2', 'aiExample3'];

export function AssistantScreen({ pollMs = 1000 }: { pollMs?: number }) {
  const { t, describeError, locale } = useI18n();
  const { colors } = useTheme();
  const { client } = useServices();
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteProp<AssistantStackParamList, 'Chat'>>();
  // An id chosen from the list wins; otherwise the chat created by this screen's first message.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const conversationId = route.params?.conversationId ?? createdId;
  const [input, setInput] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: ({ signal }) => aiApi.status(client, signal) });
  const chat = useAssistantChat(conversationId, pollMs);
  const enabled = status.data?.enabled === true;
  const locked = chat.sending || chat.busy || chat.awaiting;

  // The first message of a new chat is sent only AFTER the hook has adopted the new conversation id, otherwise the
  // hook's reset for a changed conversation could race with (and wipe) the task that this send creates.
  const pendingText = useRef<string | null>(null);
  const { send } = chat;
  useEffect(() => {
    const text = pendingText.current;
    if (!text || !conversationId) return;
    pendingText.current = null;
    void send(text, locale, conversationId).catch(() => {
      // chat.error already holds the failure.
    });
  }, [conversationId, locale, send]);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || locked || !enabled) return;
    try {
      if (!conversationId) {
        const created = await aiApi.createConversation(client, locale);
        pendingText.current = text;
        setInput('');
        setCreatedId(created.id);
        return;
      }
      setInput('');
      await send(text, locale, conversationId);
    } catch {
      // chat.error already holds a send failure; for a failed create the typed text stays so the user can retry.
    }
  }, [client, conversationId, enabled, input, locale, locked, send]);

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, [chat.messages.length, chat.view?.steps.length, chat.awaiting]);

  const errorText = chat.error ? (aiErrorKey(chat.error) ? t(aiErrorKey(chat.error) as MessageKey) : describeError(chat.error)) : null;
  const statusText = chat.status ? t(STATUS_KEY[chat.status]) : null;

  if (status.isPending)
    return (
      <Screen>
        <StateView kind="loading" title={t('loading')} />
      </Screen>
    );
  if (status.isError)
    return (
      <Screen>
        <StateView kind="error" title={describeError(status.error)} onRetry={() => void status.refetch()} />
      </Screen>
    );

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.sm }}>
          <AppText variant="title" accessibilityRole="header" style={{ flex: 1 }}>
            {t('aiTitle')}
          </AppText>
          <Button label={t('aiConversations')} variant="secondary" onPress={() => navigation.navigate('Conversations')} />
          <Button
            label={t('aiNewChat')}
            variant="secondary"
            onPress={() => {
              setCreatedId(null);
              navigation.setParams({ conversationId: undefined });
            }}
          />
        </View>

        {!enabled ? (
          <Card style={{ margin: spacing.lg, borderColor: colors.warning }}>
            <AppText accessibilityRole="alert" variant="heading" style={{ color: colors.warning }}>
              {t('aiDisabledTitle')}
            </AppText>
            <AppText muted>{t('aiDisabledBody')}</AppText>
            {status.data?.reason ? (
              <AppText variant="caption" muted>
                {status.data.reason}
              </AppText>
            ) : null}
          </Card>
        ) : (
          <>
            <FlatList
              ref={listRef}
              data={chat.messages}
              keyExtractor={(m) => m.id}
              contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, flexGrow: 1 }}
              ListEmptyComponent={
                chat.loaded ? (
                  <View style={{ gap: spacing.sm }}>
                    <AppText muted>{t('aiTryAsking')}</AppText>
                    {EXAMPLES.map((key) => (
                      <Pressable
                        key={key}
                        accessibilityRole="button"
                        accessibilityLabel={t(key)}
                        onPress={() => setInput(t(key))}
                        style={{
                          minHeight: MIN_TARGET,
                          justifyContent: 'center',
                          padding: spacing.md,
                          borderRadius: radius.md,
                          backgroundColor: colors.surface,
                        }}
                      >
                        <AppText>{t(key)}</AppText>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <StateView kind="loading" title={t('loading')} />
                )
              }
              renderItem={({ item }) => <Bubble message={item} />}
              ListFooterComponent={
                <View style={{ gap: spacing.md }}>
                  {chat.view && chat.view.steps.length > 0 ? <Steps steps={chat.view.steps} /> : null}
                  {chat.view?.confirmation && chat.awaiting ? (
                    <ConfirmationCard
                      confirmation={chat.view.confirmation}
                      busy={chat.deciding}
                      onApprove={() => void chat.approve()}
                      onReject={() => void chat.reject()}
                    />
                  ) : null}
                  {chat.busy || chat.sending ? (
                    <AppText accessibilityLiveRegion="polite" muted>
                      {statusText ?? t('aiStatusReceived')}
                    </AppText>
                  ) : statusText && chat.finished ? (
                    <AppText variant="caption" muted accessibilityLiveRegion="polite">
                      {statusText}
                    </AppText>
                  ) : null}
                </View>
              }
            />

            {errorText ? (
              <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
                <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
                  {errorText}
                </AppText>
                {chat.stalled ? <Button label={t('aiRetry')} variant="secondary" onPress={chat.resume} /> : null}
              </View>
            ) : null}

            <View style={{ padding: spacing.md, gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm }}>
                <TextInput
                  accessibilityLabel={t('aiPlaceholder')}
                  placeholder={t('aiPlaceholder')}
                  placeholderTextColor={colors.textMuted}
                  value={input}
                  onChangeText={setInput}
                  editable={!locked}
                  multiline
                  maxLength={4000}
                  maxFontSizeMultiplier={1.6}
                  style={{
                    flex: 1,
                    maxHeight: 120,
                    minHeight: MIN_TARGET,
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: radius.md,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                    color: colors.text,
                    backgroundColor: colors.surface,
                    fontSize: 16,
                  }}
                />
                {chat.busy || chat.awaiting ? (
                  <Button label={t('aiStop')} variant="secondary" onPress={() => void chat.cancel()} busy={chat.deciding} />
                ) : (
                  <Button label={t('aiSend')} onPress={() => void submit()} disabled={input.trim() === '' || locked} busy={chat.sending} />
                )}
              </View>
              <AppText variant="caption" muted>
                {t('aiDisclaimer')}
              </AppText>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const mine = message.role === 'user';
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <View
        style={{
          maxWidth: '90%',
          padding: spacing.md,
          borderRadius: radius.lg,
          backgroundColor: mine ? colors.primary : colors.surface,
          gap: spacing.xs,
        }}
      >
        <AppText variant="caption" style={{ color: mine ? colors.onPrimary : colors.textMuted, fontWeight: '700' }}>
          {mine ? t('aiYou') : t('aiAssistantName')}
        </AppText>
        {mine ? (
          <AppText selectable style={{ color: colors.onPrimary }}>
            {message.content}
          </AppText>
        ) : (
          <Markdown text={message.content} />
        )}
      </View>
    </View>
  );
}

function Steps({ steps }: { steps: StepDto[] }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  return (
    <Card style={{ gap: spacing.xs }}>
      <AppText variant="label">{t('aiStepsHeading')}</AppText>
      {steps.map((step) => (
        <View key={step.id}>
          <AppText variant="caption" style={{ fontWeight: '600', color: step.status === 'FAILED' ? colors.danger : colors.text }}>
            {`${humanizeTool(step.tool)} · ${t(STEP_KEY[step.status])}`}
          </AppText>
          {step.summary ? (
            <AppText variant="caption" muted>
              {step.summary}
            </AppText>
          ) : null}
        </View>
      ))}
    </Card>
  );
}
