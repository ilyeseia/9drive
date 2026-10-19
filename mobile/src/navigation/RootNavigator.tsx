import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useI18n } from '../i18n/I18nProvider';
import { useTheme } from '../theme/theme';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { FilesStack } from './FilesStack';
import { OfflineBanner } from '../ui/Offline';
import { Platform, View } from 'react-native';
import { Icon, type IconName } from '../ui/Icon';
import { StorageStack } from './StorageStack';
import { AssistantStack } from './AssistantStack';

export type TabParamList = {
  Files: undefined;
  Storage: undefined;
  Assistant: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

const TAB_ICONS: Record<keyof TabParamList, IconName> = {
  Files: 'folder',
  Storage: 'cloud',
  Assistant: 'chat',
  Settings: 'sliders',
};

export function RootNavigator() {
  const { t } = useI18n();
  const { colors, scheme } = useTheme();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      primary: colors.primary,
    },
  };

  return (
    <NavigationContainer theme={navTheme}>
      <View style={{ flex: 1 }}>
        <OfflineBanner />
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarActiveTintColor: colors.primary,
            tabBarInactiveTintColor: colors.textMuted,
            tabBarHideOnKeyboard: true,
            tabBarLabelStyle: { fontSize: 12, fontWeight: '700', marginBottom: Platform.OS === 'android' ? 6 : 0 },
            tabBarStyle: {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              borderTopWidth: 1,
              height: Platform.OS === 'android' ? 68 : undefined,
              paddingTop: 6,
            },
            tabBarIcon: ({ color, focused }) => (
              <Icon name={TAB_ICONS[route.name]} size={focused ? 25 : 23} color={color} strokeWidth={focused ? 2.4 : 2} />
            ),
          })}
        >
          <Tab.Screen name="Files" options={{ title: t('tabFiles'), tabBarAccessibilityLabel: t('tabFiles') }} component={FilesStack} />
          <Tab.Screen
            name="Storage"
            options={{ title: t('tabStorage'), tabBarAccessibilityLabel: t('tabStorage') }}
            component={StorageStack}
          />
          <Tab.Screen
            name="Assistant"
            options={{ title: t('tabAssistant'), tabBarAccessibilityLabel: t('tabAssistant') }}
            component={AssistantStack}
          />
          <Tab.Screen
            name="Settings"
            options={{ title: t('tabSettings'), tabBarAccessibilityLabel: t('tabSettings') }}
            component={SettingsScreen}
          />
        </Tab.Navigator>
      </View>
    </NavigationContainer>
  );
}
