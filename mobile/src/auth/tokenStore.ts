/**
 * Persistent credentials. The only place tokens are stored.
 *
 * - Production storage is the platform keystore (iOS Keychain / Android Keystore-backed EncryptedSharedPreferences)
 *   through `expo-secure-store`, with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: readable only while the device is
 *   unlocked and never migrated to another device or included in backups.
 * - Passwords are never stored. Only the (rotating) refresh token and the short-lived access token are.
 * - The stored blob is validated on read; anything corrupt is treated as "no session" and wiped.
 */

import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';
import { log } from '../core/logger';
import { userSchema } from '../api/endpoints/auth';

export const storedSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  user: userSchema,
});
export type StoredSession = z.infer<typeof storedSessionSchema>;

export interface TokenStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}

const KEY = '9drive.session.v1';

export class SecureTokenStore implements TokenStore {
  private readonly options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

  async load(): Promise<StoredSession | null> {
    let raw: string | null;
    try {
      raw = await SecureStore.getItemAsync(KEY, this.options);
    } catch {
      log.warn('Secure storage could not be read');
      return null;
    }
    if (!raw) return null;
    try {
      const parsed = storedSessionSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to wipe
    }
    log.warn('Stored session was corrupt and has been removed');
    await this.clear();
    return null;
  }

  async save(session: StoredSession): Promise<void> {
    await SecureStore.setItemAsync(KEY, JSON.stringify(session), this.options);
  }

  async clear(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(KEY, this.options);
    } catch {
      log.warn('Secure storage could not be cleared');
    }
  }
}

/** In-memory store for tests and previews. */
export class MemoryTokenStore implements TokenStore {
  constructor(public value: StoredSession | null = null) {}
  async load() {
    return this.value;
  }
  async save(session: StoredSession) {
    this.value = session;
  }
  async clear() {
    this.value = null;
  }
}
