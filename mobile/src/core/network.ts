import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/** `isInternetReachable` is null while unknown: only a definite "no" counts as offline. */
export function isOnlineState(state: Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>): boolean {
  if (state.isConnected === false) return false;
  return state.isInternetReachable !== false;
}

/**
 * Tells React Query about connectivity so list queries pause (and keep showing their last data) while offline.
 * Mutations deliberately do NOT queue: see `mutationDefaults` in App.tsx.
 */
export function initOnlineManager(): void {
  onlineManager.setEventListener((setOnline) => NetInfo.addEventListener((state) => setOnline(isOnlineState(state))));
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => setOnline(isOnlineState(state)));
    return unsubscribe;
  }, []);
  return online;
}
