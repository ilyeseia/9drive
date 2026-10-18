import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { ApiClient } from '../api/client';
import { DeviceAuthenticator, loadLockSettings, saveLockSettings } from '../auth/biometric';
import { LockController, type LockState } from '../auth/lock';
import { SessionManager, type SessionState } from '../auth/session';
import { SecureTokenStore, type TokenStore } from '../auth/tokenStore';
import { TransferManager, type TransferItem } from '../transfers/manager';
import { DeviceFileSource, chunkFetch, clearDownloadCache, createDownloader, prefsTransferPersistence } from '../transfers/device';
import { UploadRunner, createUploadApi } from '../transfers/upload';
import { clearOfflineCache } from '../core/offlineCache';

export interface Services {
  client: ApiClient;
  session: SessionManager;
  lock: LockController;
  transfers: TransferManager;
  queryClient: QueryClient;
}

export interface ServiceOverrides {
  client?: ApiClient;
  store?: TokenStore;
  lock?: LockController;
  transfers?: TransferManager;
}

/**
 * Composition root: wires the client, session, lock and transfers together. When the session ends, every cache
 * that may hold user data is cleared: queries, queued transfers and downloaded copies, and the app lock resets.
 */
export function createServices(apiBaseUrl: string, queryClient: QueryClient, overrides: ServiceOverrides = {}): Services {
  const client = overrides.client ?? new ApiClient({ baseUrl: apiBaseUrl });
  const lock =
    overrides.lock ?? new LockController({ authenticator: new DeviceAuthenticator(), load: loadLockSettings, save: saveLockSettings });
  const transfers =
    overrides.transfers ??
    new TransferManager({
      runner: new UploadRunner(createUploadApi(client, chunkFetch)),
      makeSource: (meta) => new DeviceFileSource(meta),
      download: createDownloader(client),
      newId: () => randomUUID(),
      persistence: prefsTransferPersistence,
      // A finished upload changes what the file lists should show.
      onUploaded: () => void queryClient.invalidateQueries({ queryKey: ['files'] }),
    });
  const session = new SessionManager(client, overrides.store ?? new SecureTokenStore(), {
    onCleared: () => {
      queryClient.clear();
      transfers.reset();
      clearDownloadCache();
      void clearOfflineCache();
      lock.reset();
    },
  });
  return { client, session, lock, transfers, queryClient };
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

export function useTransfers(): TransferItem[] {
  const { transfers } = useServices();
  return useSyncExternalStore(transfers.subscribe, transfers.getSnapshot, transfers.getSnapshot);
}
