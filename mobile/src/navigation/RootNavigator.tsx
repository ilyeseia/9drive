import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useI18n } from '../i18n/I18nProvider';
import { useTheme } from '../theme/theme';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { PlaceholderScreen } from '../features/PlaceholderScreen';
import { FilesStack } from './FilesStack';
import { OfflineBanner } from '../ui/Offline';
import { View } from 'react-native';
import { StorageStack } from './StorageStack';

export type TabParamList = {
  Files: undefined;
  Storage: undefined;
  Assistant: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

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
          screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.textMuted }}
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
            component={PlaceholderScreen}
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
