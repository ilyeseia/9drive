import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { autoSaveSnapshots, loadOfflineSetting, offlineSettingStore, restoreSnapshot } from '../core/offlineCache';

/**
 * Renders nothing. While the user is signed in and has opted in, restores the saved copy once and keeps it
 * up to date. When the option is off nothing is read or written.
 */
export function OfflineCacheController() {
  const queryClient = useQueryClient();
  const enabled = useSyncExternalStore(offlineSettingStore.subscribe, offlineSettingStore.get, offlineSettingStore.get);

  useEffect(() => {
    void loadOfflineSetting();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void restoreSnapshot(queryClient).then(() => {
      if (!cancelled) stop = autoSaveSnapshots(queryClient);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [enabled, queryClient]);

  return null;
}
