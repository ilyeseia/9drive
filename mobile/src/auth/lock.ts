/**
 * Optional app lock (biometrics or the device passcode) and inactivity timeout.
 *
 * What this is: a local privacy screen so someone holding an unlocked phone cannot open 9Drive.
 * What this is NOT: authentication. The server session (tokens) is unchanged by it, every API call is still
 * authorised by the server, and unlocking never grants anything the signed-in user did not already have.
 *
 * Behaviour is fail-closed: if authentication cannot be performed the app stays locked and the user can sign out.
 * A cold start with the lock enabled always starts locked.
 */

export type Availability = 'ok' | 'no_hardware' | 'not_enrolled';

export interface Authenticator {
  availability(): Promise<Availability>;
  authenticate(prompt: { title: string; cancel: string }): Promise<boolean>;
}

export interface LockSettings {
  enabled: boolean;
  /** Seconds in the background (or idle) before locking. 0 = lock as soon as the app leaves the foreground. */
  timeoutSec: number;
}

export const TIMEOUT_CHOICES = [0, 60, 300, 900] as const;
export const DEFAULT_SETTINGS: LockSettings = { enabled: false, timeoutSec: 0 };
/** Foreground idle limit used when the user chose "immediately" (which only governs backgrounding). */
const IDLE_WHEN_IMMEDIATE_SEC = 120;

export interface LockState {
  ready: boolean;
  locked: boolean;
  settings: LockSettings;
}

export interface LockDeps {
  authenticator: Authenticator;
  load: () => Promise<LockSettings>;
  save: (settings: LockSettings) => Promise<void>;
  now?: () => number;
}

export type EnableResult = 'enabled' | 'no_hardware' | 'not_enrolled' | 'failed';

export class LockController {
  private state: LockState = { ready: false, locked: false, settings: DEFAULT_SETTINGS };
  private backgroundedAt: number | null = null;
  private lastActive: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: LockDeps) {
    this.now = deps.now ?? Date.now;
    this.lastActive = this.now();
  }

  getState = (): LockState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<LockState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  async init(): Promise<void> {
    const settings = await this.deps.load();
    // Cold start: if the lock is on, the app starts locked.
    this.set({ ready: true, settings, locked: settings.enabled });
  }

  onBackground(): void {
    this.backgroundedAt = this.now();
  }

  onForeground(): void {
    const { settings, locked } = this.state;
    const since = this.backgroundedAt;
    this.backgroundedAt = null;
    if (!settings.enabled || locked || since === null) return;
    if (settings.timeoutSec === 0 || this.now() - since >= settings.timeoutSec * 1000) this.set({ locked: true });
    this.lastActive = this.now();
  }

  /** Call on user interaction. */
  touch(): void {
    this.lastActive = this.now();
  }

  /** Call periodically while the app is in the foreground. */
  tick(): void {
    const { settings, locked } = this.state;
    if (!settings.enabled || locked) return;
    const limit = (settings.timeoutSec === 0 ? IDLE_WHEN_IMMEDIATE_SEC : settings.timeoutSec) * 1000;
    if (this.now() - this.lastActive >= limit) this.set({ locked: true });
  }

  lockNow(): void {
    if (this.state.settings.enabled) this.set({ locked: true });
  }

  async unlock(prompt: { title: string; cancel: string }): Promise<boolean> {
    if (!this.state.locked) return true;
    let ok = false;
    try {
      ok = await this.deps.authenticator.authenticate(prompt);
    } catch {
      ok = false;
    }
    if (ok) {
      this.lastActive = this.now();
      this.set({ locked: false });
    }
    return ok;
  }

  /** Turning the lock on requires proof that it can actually be satisfied, otherwise the user could lock themselves out. */
  async enable(prompt: { title: string; cancel: string }): Promise<EnableResult> {
    const availability = await this.deps.authenticator.availability();
    if (availability !== 'ok') return availability;
    let ok = false;
    try {
      ok = await this.deps.authenticator.authenticate(prompt);
    } catch {
      ok = false;
    }
    if (!ok) return 'failed';
    const settings = { ...this.state.settings, enabled: true };
    await this.deps.save(settings);
    this.lastActive = this.now();
    this.set({ settings, locked: false });
    return 'enabled';
  }

  /** Turning the lock off also requires authentication, so a borrowed unlocked phone cannot remove it silently. */
  async disable(prompt: { title: string; cancel: string }): Promise<boolean> {
    let ok = false;
    try {
      ok = await this.deps.authenticator.authenticate(prompt);
    } catch {
      ok = false;
    }
    if (!ok) return false;
    const settings = { ...this.state.settings, enabled: false };
    await this.deps.save(settings);
    this.set({ settings, locked: false });
    return true;
  }

  async setTimeout(timeoutSec: number): Promise<void> {
    if (!(TIMEOUT_CHOICES as readonly number[]).includes(timeoutSec)) return;
    const settings = { ...this.state.settings, timeoutSec };
    await this.deps.save(settings);
    this.set({ settings });
  }

  /** Used by sign-out: the lock belongs to a signed-in session. */
  reset(): void {
    this.set({ locked: false });
  }
}
