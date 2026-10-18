import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AssistantScreen } from '../features/assistant/AssistantScreen';
import { ConversationsScreen } from '../features/assistant/ConversationsScreen';
import { useI18n } from '../i18n/I18nProvider';

export type AssistantStackParamList = {
  Chat: { conversationId?: string } | undefined;
  Conversations: undefined;
};

const Stack = createNativeStackNavigator<AssistantStackParamList>();

export function AssistantStack() {
  const { t } = useI18n();
  return (
    <Stack.Navigator>
      <Stack.Screen name="Chat" component={AssistantScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Conversations" component={ConversationsScreen} options={{ title: t('aiConversations') }} />
    </Stack.Navigator>
  );
}
