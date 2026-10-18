import { LockController, type Authenticator, type Availability, type LockSettings } from './lock';

const PROMPT = { title: 'Unlock', cancel: 'Cancel' };

function make(
  initial: LockSettings = { enabled: true, timeoutSec: 60 },
  opts: { availability?: Availability; auth?: () => Promise<boolean> } = {},
) {
  let now = 1_000_000;
  const saved: LockSettings[] = [];
  const auth = jest.fn(opts.auth ?? (async () => true));
  const authenticator: Authenticator = { availability: async () => opts.availability ?? 'ok', authenticate: auth };
  const lock = new LockController({ authenticator, load: async () => initial, save: async (s) => void saved.push(s), now: () => now });
  return { lock, auth, saved, advance: (ms: number) => void (now += ms) };
}

describe('LockController', () => {
  it('starts locked on a cold start when the lock is enabled, and unlocked when it is not', async () => {
    const on = make();
    await on.lock.init();
    expect(on.lock.getState()).toMatchObject({ ready: true, locked: true });
    const off = make({ enabled: false, timeoutSec: 0 });
    await off.lock.init();
    expect(off.lock.getState().locked).toBe(false);
  });

  it('unlocks only after a successful device authentication (fail closed)', async () => {
    let succeed = false;
    const { lock } = make(undefined, { auth: async () => succeed });
    await lock.init();
    await expect(lock.unlock(PROMPT)).resolves.toBe(false);
    expect(lock.getState().locked).toBe(true);
    succeed = true;
    await expect(lock.unlock(PROMPT)).resolves.toBe(true);
    expect(lock.getState().locked).toBe(false);
  });

  it('treats an authenticator exception as a failed unlock', async () => {
    const { lock } = make(undefined, {
      auth: async () => {
        throw new Error('sensor error');
      },
    });
    await lock.init();
    await expect(lock.unlock(PROMPT)).resolves.toBe(false);
    expect(lock.getState().locked).toBe(true);
  });

  it('locks immediately on return when the timeout is 0, and only after the timeout otherwise', async () => {
    const immediate = make({ enabled: true, timeoutSec: 0 });
    await immediate.lock.init();
    await immediate.lock.unlock(PROMPT);
    immediate.lock.onBackground();
    immediate.advance(500);
    immediate.lock.onForeground();
    expect(immediate.lock.getState().locked).toBe(true);

    const timed = make({ enabled: true, timeoutSec: 60 });
    await timed.lock.init();
    await timed.lock.unlock(PROMPT);
    timed.lock.onBackground();
    timed.advance(59_000);
    timed.lock.onForeground();
    expect(timed.lock.getState().locked).toBe(false);
    timed.lock.onBackground();
    timed.advance(60_000);
    timed.lock.onForeground();
    expect(timed.lock.getState().locked).toBe(true);
  });

  it('locks after foreground inactivity and resets the idle clock on touch', async () => {
    const { lock, advance } = make({ enabled: true, timeoutSec: 60 });
    await lock.init();
    await lock.unlock(PROMPT);
    advance(59_000);
    lock.touch();
    advance(59_000);
    lock.tick();
    expect(lock.getState().locked).toBe(false);
    advance(2_000);
    lock.tick();
    expect(lock.getState().locked).toBe(true);
  });

  it('never locks when disabled', async () => {
    const { lock, advance } = make({ enabled: false, timeoutSec: 0 });
    await lock.init();
    lock.onBackground();
    advance(10 * 60_000);
    lock.onForeground();
    lock.tick();
    lock.lockNow();
    expect(lock.getState().locked).toBe(false);
  });

  it('enabling requires available hardware/enrolment and a successful authentication', async () => {
    const none = make({ enabled: false, timeoutSec: 0 }, { availability: 'no_hardware' });
    await none.lock.init();
    await expect(none.lock.enable(PROMPT)).resolves.toBe('no_hardware');
    expect(none.saved).toEqual([]);

    const notEnrolled = make({ enabled: false, timeoutSec: 0 }, { availability: 'not_enrolled' });
    await notEnrolled.lock.init();
    await expect(notEnrolled.lock.enable(PROMPT)).resolves.toBe('not_enrolled');

    const refused = make({ enabled: false, timeoutSec: 0 }, { auth: async () => false });
    await refused.lock.init();
    await expect(refused.lock.enable(PROMPT)).resolves.toBe('failed');
    expect(refused.lock.getState().settings.enabled).toBe(false);

    const ok = make({ enabled: false, timeoutSec: 0 });
    await ok.lock.init();
    await expect(ok.lock.enable(PROMPT)).resolves.toBe('enabled');
    expect(ok.saved.at(-1)).toEqual({ enabled: true, timeoutSec: 0 });
    expect(ok.lock.getState().locked).toBe(false);
  });

  it('disabling also requires authentication', async () => {
    const { lock, saved } = make({ enabled: true, timeoutSec: 60 }, { auth: async () => false });
    await lock.init();
    await expect(lock.disable(PROMPT)).resolves.toBe(false);
    expect(lock.getState().settings.enabled).toBe(true);
    expect(saved).toEqual([]);
  });

  it('accepts only the offered timeout choices', async () => {
    const { lock, saved } = make();
    await lock.init();
    await lock.setTimeout(300);
    await lock.setTimeout(7);
    expect(lock.getState().settings.timeoutSec).toBe(300);
    expect(saved).toHaveLength(1);
  });

  it('is released by reset (sign-out)', async () => {
    const { lock } = make();
    await lock.init();
    expect(lock.getState().locked).toBe(true);
    lock.reset();
    expect(lock.getState().locked).toBe(false);
  });
});
