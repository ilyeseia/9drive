/**
 * Non-sensitive preferences (language, theme). Backed by AsyncStorage, which is NOT secure storage:
 * nothing in here may be a credential, token or personal data. Tokens live in `auth/secureStore`.
 *
 * The backing store is injectable so tests do not need a native module.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

let store: KeyValueStore = AsyncStorage;

export function setPrefsStore(next: KeyValueStore): void {
  store = next;
}

export async function readPref(key: string): Promise<string | null> {
  try {
    return await store.getItem(`9drive.pref.${key}`);
  } catch {
    return null;
  }
}

export async function writePref(key: string, value: string): Promise<void> {
  try {
    await store.setItem(`9drive.pref.${key}`, value);
  } catch {
    // Preferences are a convenience; failing to persist must never break the app.
  }
}
