import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { ApiClient } from '../api/client';
import { DeviceAuthenticator, loadLockSettings, saveLockSettings } from '../auth/biometric';
import { LockController, type LockState } from '../auth/lock';
import { SessionManager, type SessionState } from '../auth/session';
import { SecureTokenStore, type TokenStore } from '../auth/tokenStore';

export interface Services {
  client: ApiClient;
  session: SessionManager;
  lock: LockController;
}

export interface ServiceOverrides {
  client?: ApiClient;
  store?: TokenStore;
  lock?: LockController;
}

/**
 * Composition root: wires the client, session and lock together. When the session ends, every cache that may
 * hold user data is cleared and the app lock is reset.
 */
export function createServices(apiBaseUrl: string, queryClient: QueryClient, overrides: ServiceOverrides = {}): Services {
  const client = overrides.client ?? new ApiClient({ baseUrl: apiBaseUrl });
  const lock =
    overrides.lock ?? new LockController({ authenticator: new DeviceAuthenticator(), load: loadLockSettings, save: saveLockSettings });
  const session = new SessionManager(client, overrides.store ?? new SecureTokenStore(), {
    onCleared: () => {
      queryClient.clear();
      lock.reset();
    },
  });
  return { client, session, lock };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const value = useContext(ServicesContext);
  if (!value) throw new Error('useServices must be used inside <ServicesProvider>.');
  return value;
}

export function useSession(): SessionState {
  const { session } = useServices();
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}

export function useLockState(): LockState {
  const { lock } = useServices();
  return useSyncExternalStore(lock.subscribe, lock.getState, lock.getState);
}
