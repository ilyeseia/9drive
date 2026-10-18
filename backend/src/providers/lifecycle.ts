/**
 * Connected-account lifecycle (docs/provider-audit, finding F13).
 *
 * `ConnectedAccount.status` stays a string column so the migration is additive and old rows keep working. The legacy
 * values (`connected`, `unauthorized`, `disconnected`, `pending`, `error`) are mapped onto the explicit states below;
 * new code writes the explicit names and routes every change through `assertTransition`.
 */

export const ACCOUNT_STATES = [
  'pending_authorization',
  'connected',
  'degraded',
  'temporarily_unavailable',
  'reauthorization_required',
  'disabled',
  'disconnecting',
  'disconnected',
  'error',
] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

const LEGACY_STATUS: Record<string, AccountState> = {
  pending: 'pending_authorization',
  unauthorized: 'reauthorization_required',
};

export function normalizeAccountState(status: string): AccountState | null {
  const mapped = LEGACY_STATUS[status] ?? status;
  return (ACCOUNT_STATES as readonly string[]).includes(mapped) ? (mapped as AccountState) : null;
}

const ACTIVE: AccountState[] = ['connected', 'degraded', 'temporarily_unavailable', 'reauthorization_required', 'error'];

const TRANSITIONS: Record<AccountState, readonly AccountState[]> = {
  pending_authorization: ['connected', 'error', 'disconnected'],
  connected: ['degraded', 'temporarily_unavailable', 'reauthorization_required', 'error', 'disabled', 'disconnecting'],
  degraded: ['connected', 'temporarily_unavailable', 'reauthorization_required', 'error', 'disabled', 'disconnecting'],
  temporarily_unavailable: ['connected', 'degraded', 'reauthorization_required', 'error', 'disabled', 'disconnecting'],
  reauthorization_required: ['connected', 'disabled', 'disconnecting', 'error'],
  error: ['connected', 'degraded', 'temporarily_unavailable', 'reauthorization_required', 'disabled', 'disconnecting'],
  disabled: ['connected', 'disconnecting'],
  disconnecting: ['disconnected', 'error'],
  // Reconnecting an account revives the same row (files keep their link).
  disconnected: ['connected', 'pending_authorization'],
};

/** Same-state "transitions" are always allowed (idempotent updates). */
export function canTransition(from: AccountState, to: AccountState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export class InvalidAccountTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`account state transition ${from} -> ${to} is not allowed`);
    this.name = 'InvalidAccountTransitionError';
  }
}

export function assertTransition(from: string, to: AccountState): void {
  const current = normalizeAccountState(from);
  if (current === null || !canTransition(current, to)) throw new InvalidAccountTransitionError(from, to);
}

/** States whose accounts may carry traffic (routing still applies its own health/quota checks). */
export function isRoutable(status: string): boolean {
  const state = normalizeAccountState(status);
  return state === 'connected' || state === 'degraded';
}

export interface AccountStateDescription {
  /** Explicit lifecycle state, or null for an unrecognised legacy value. */
  state: AccountState | null;
  /** The user must authorise again (revoked/expired credentials). */
  needsReauthorization: boolean;
  /** Connected, but the last provider call failed for a reason that is not the user's credentials. */
  hasTransientIssue: boolean;
  /** Whether routing may select this account at all. */
  routable: boolean;
}

export function describeAccountState(status: string, lastError?: string | null): AccountStateDescription {
  const state = normalizeAccountState(status);
  return {
    state,
    needsReauthorization: state === 'reauthorization_required',
    hasTransientIssue: (state === 'connected' || state === 'degraded') && Boolean(lastError),
    routable: isRoutable(status),
  };
}

export function isActiveState(status: string): boolean {
  const state = normalizeAccountState(status);
  return state !== null && ACTIVE.includes(state);
}
