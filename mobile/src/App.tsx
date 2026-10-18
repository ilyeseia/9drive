import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { I18nProvider, useI18n } from './i18n/I18nProvider';
import { ThemeProvider, useTheme } from './theme/theme';
import { ConfigError, isConfigError, loadConfig, type AppConfig } from './config/env';
import { RootNavigator } from './navigation/RootNavigator';
import { Screen, StateView } from './ui/components';
import type { MessageKey } from './i18n/messages';
import { ServicesProvider, createServices, useServices, useSession } from './app/services';
import { AuthScreen } from './features/auth/AuthScreen';
import { LockGate } from './features/auth/LockGate';
import { OfflineCacheController } from './app/OfflineCacheController';
import { initOnlineManager } from './core/network';
import { createQueryClient } from './app/queryClient';

initOnlineManager();

const CONFIG_KEYS: Record<ConfigError['reason'], { title: MessageKey; body: MessageKey }> = {
  missing: { title: 'configMissingTitle', body: 'configMissingBody' },
  invalid: { title: 'configInvalidTitle', body: 'configInvalidBody' },
  insecure: { title: 'configInsecureTitle', body: 'configInsecureBody' },
};

/** Chooses what to show from the session state: restoring → sign-in → (lock →) the app. */
function SessionGate() {
  const { t } = useI18n();
  const { session } = useServices();
  const state = useSession();

  useEffect(() => {
    void session.restore();
  }, [session]);

  if (state.status === 'loading') {
    return (
      <Screen>
        <StateView kind="loading" title={t('loading')} />
      </Screen>
    );
  }
  if (state.status === 'signedOut') return <AuthScreen reason={state.reason} />;
  return (
    <LockGate onSignOut={() => void session.signOut()}>
      <OfflineCacheController />
      <RootNavigator />
    </LockGate>
  );
}

function ConfiguredApp({ config }: { config: AppConfig }) {
  const queryClient = useQueryClient();
  const services = useMemo(() => createServices(config.apiBaseUrl, queryClient), [config.apiBaseUrl, queryClient]);
  return (
    <ServicesProvider services={services}>
      <SessionGate />
    </ServicesProvider>
  );
}

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
        <ConfiguredApp config={config} />
      )}
    </>
  );
}

export default function App() {
  const [queryClient] = useState(createQueryClient);
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
