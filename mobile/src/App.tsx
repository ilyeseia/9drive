import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { I18nProvider, useI18n } from './i18n/I18nProvider';
import { ThemeProvider, useTheme } from './theme/theme';
import { ConfigError, isConfigError, loadConfig } from './config/env';
import { RootNavigator } from './navigation/RootNavigator';
import { Screen, StateView } from './ui/components';
import type { MessageKey } from './i18n/messages';

const CONFIG_KEYS: Record<ConfigError['reason'], { title: MessageKey; body: MessageKey }> = {
  missing: { title: 'configMissingTitle', body: 'configMissingBody' },
  invalid: { title: 'configInvalidTitle', body: 'configInvalidBody' },
  insecure: { title: 'configInsecureTitle', body: 'configInsecureBody' },
};

function Shell() {
  const { t } = useI18n();
  const { scheme } = useTheme();
  const config = loadConfig();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {isConfigError(config) ? (
        <Screen>
          <StateView kind="error" title={t(CONFIG_KEYS[config.reason].title)} message={t(CONFIG_KEYS[config.reason].body)} />
        </Screen>
      ) : (
        <RootNavigator />
      )}
    </>
  );
}

export default function App() {
  // One QueryClient per app instance. Defaults are conservative: no retry here, because the API client already
  // retries safe requests with bounded backoff; refetch-on-focus is explicit per screen.
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } }));
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <I18nProvider>
          <QueryClientProvider client={queryClient}>
            <Shell />
          </QueryClientProvider>
        </I18nProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
