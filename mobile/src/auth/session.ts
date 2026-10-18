/**
 * Session lifecycle: sign-in, restore, rotation-safe refresh, sign-out.
 *
 * Design constraints taken from the backend (docs/mobile/00-audit-and-plan.md §2):
 *  - Refresh tokens ROTATE and a reused one revokes the whole session. So refresh is SINGLE-FLIGHT, and the new
 *    pair is persisted BEFORE the new access token is handed out.
 *  - A transient failure (offline, timeout) while refreshing must NOT end the session.
 *  - Sign-out always clears local credentials, even when the server cannot be reached.
 *
 * The manager is an observable store (no React dependency) so it can be tested without a renderer.
 */

import { authApi, type User } from '../api/endpoints/auth';
import type { ApiClient, AuthHooks } from '../api/client';
import { ApiError } from '../api/errors';
import { log } from '../core/logger';
import type { StoredSession, TokenStore } from './tokenStore';

export type SessionLoss = 'expired' | 'disabled' | 'compromised';

export type SessionState = { status: 'loading' } | { status: 'signedOut'; reason: SessionLoss | null } | { status: 'signedIn'; user: User };

interface Tokens {
  access: string;
  refresh: string;
}

export interface SessionManagerOptions {
  /** Called whenever credentials are dropped, so caches of user data can be wiped too. */
  onCleared?: () => void;
}

export class SessionManager implements AuthHooks {
  private state: SessionState = { status: 'loading' };
  private tokens: Tokens | null = null;
  private user: User | null = null;
  private refreshing: Promise<string | null> | null = null;
  private unsavedTokens = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly client: ApiClient,
    private readonly store: TokenStore,
    private readonly options: SessionManagerOptions = {},
  ) {
    client.setAuthHooks(this);
  }

  // ---- observable ---------------------------------------------------------------------------

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(state: SessionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  // ---- AuthHooks (used by ApiClient) -------------------------------------------------------

  async getAccessToken(): Promise<string | null> {
    if (this.unsavedTokens) await this.persist();
    return this.tokens?.access ?? null;
  }

  refreshAccessToken(rejectedToken: string | null): Promise<string | null> {
    // Another caller already renewed the token this request was using: reuse it instead of rotating again.
    if (rejectedToken && this.tokens && this.tokens.access !== rejectedToken) return Promise.resolve(this.tokens.access);
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  onSessionLost(reason: 'expired' | 'disabled'): void {
    void this.endSession(reason);
  }

  private async doRefresh(): Promise<string | null> {
    const current = this.tokens;
    if (!current) return null;
    let response;
    try {
      response = await authApi.refresh(this.client, current.refresh);
    } catch (error) {
      if (ApiError.is(error) && (error.kind === 'unauthorized' || error.kind === 'forbidden' || error.kind === 'disabled')) {
        await this.endSession(
          error.code === 'AUTH_SESSION_COMPROMISED' ? 'compromised' : error.kind === 'disabled' ? 'disabled' : 'expired',
        );
        return null;
      }
      throw error; // transient or unexpected: keep the session
    }
    this.tokens = { access: response.accessToken, refresh: response.refreshToken };
    // Persist-before-use: if the process dies right after this, the stored refresh token must be the new one.
    await this.persist();
    return this.tokens.access;
  }

  private async persist(): Promise<void> {
    if (!this.tokens || !this.user) return;
    const snapshot: StoredSession = { accessToken: this.tokens.access, refreshToken: this.tokens.refresh, user: this.user };
    try {
      await this.store.save(snapshot);
      this.unsavedTokens = false;
    } catch {
      // Keep working from memory and retry on the next call; never fall back to insecure storage.
      this.unsavedTokens = true;
      log.warn('Session could not be saved to secure storage; will retry');
    }
  }

  // ---- user actions ------------------------------------------------------------------------

  /** Loads a saved session. Offline-safe: a saved session is trusted locally and validated in the background. */
  async restore(): Promise<void> {
    const saved = await this.store.load();
    if (!saved) {
      this.set({ status: 'signedOut', reason: null });
      return;
    }
    this.tokens = { access: saved.accessToken, refresh: saved.refreshToken };
    this.user = saved.user;
    this.set({ status: 'signedIn', user: saved.user });
    void this.validate();
  }

  /** Confirms the saved session with the server and refreshes the profile. Errors other than auth are ignored. */
  async validate(): Promise<void> {
    try {
      const { user } = await authApi.me(this.client);
      const merged: User = { id: user.id, name: user.name, email: user.email };
      if (this.state.status === 'signedIn') {
        this.user = merged;
        this.set({ status: 'signedIn', user: merged });
        await this.persist();
      }
    } catch {
      // 401/403 already ended the session through onSessionLost; offline etc. leaves the local session intact.
    }
  }

  async signIn(email: string, password: string): Promise<void> {
    const response = await authApi.login(this.client, email, password);
    await this.adopt(response.accessToken, response.refreshToken, response.user);
  }

  async register(name: string, email: string, password: string): Promise<void> {
    const response = await authApi.register(this.client, name, email, password);
    await this.adopt(response.accessToken, response.refreshToken, response.user);
  }

  private async adopt(access: string, refresh: string, user: User): Promise<void> {
    this.tokens = { access, refresh };
    this.user = user;
    await this.persist();
    this.set({ status: 'signedIn', user });
  }

  /**
   * Signs out on this device. The server is asked to revoke the session first (best effort, 5 s); whatever happens,
   * local credentials and cached data are removed. Returns whether the server confirmed the revocation.
   */
  async signOut(): Promise<{ serverRevoked: boolean }> {
    let serverRevoked = false;
    if (this.tokens) {
      try {
        await authApi.logout(this.client);
        serverRevoked = true;
      } catch {
        log.warn('Server could not confirm sign-out; local credentials are removed anyway');
      }
    }
    await this.endSession(null);
    return { serverRevoked };
  }

  private async endSession(reason: SessionLoss | null): Promise<void> {
    if (this.state.status === 'signedOut' && this.tokens === null) return;
    this.tokens = null;
    this.user = null;
    this.unsavedTokens = false;
    this.set({ status: 'signedOut', reason });
    await this.store.clear();
    this.options.onCleared?.();
  }
}
