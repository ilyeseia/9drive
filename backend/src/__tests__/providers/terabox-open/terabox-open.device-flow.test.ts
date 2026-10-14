import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryDeviceFlowStore,
  pollTeraBoxDeviceFlow,
  startTeraBoxDeviceFlow,
  type DeviceFlowDeps,
} from '../../../modules/providers/terabox-device-flow.js';
import { RequestError } from '../../../modules/providers/http-error.js';

const TOKENS = { accessToken: 'AT-secret', refreshToken: 'RT-secret', expiresAt: Date.now() + 172_800_000 };

function makeDeps(overrides: Partial<DeviceFlowDeps> = {}) {
  let now = 1_000_000;
  const store = createMemoryDeviceFlowStore();
  const calls = { start: 0, poll: 0, finalize: 0 };
  const deps: DeviceFlowDeps = {
    store,
    now: () => now,
    loadApp: async () => ({
      config: { id: 'cfg-1' } as never,
      creds: { clientId: 'cid', clientSecret: 'csec', privateSecret: 'psec' },
    }),
    start: async () => {
      calls.start += 1;
      return { deviceCode: `device-${calls.start}`, qrCodeDataUrl: 'data:image/png;base64,AAAA', expiresInSeconds: 300, intervalSeconds: 2 };
    },
    poll: async () => {
      calls.poll += 1;
      return { status: 'pending' };
    },
    finalize: async () => {
      calls.finalize += 1;
      return { accountId: 'acct-1' };
    },
    ...overrides,
  };
  return { deps, store, calls, advance: (ms: number) => (now += ms) };
}

async function expectRequestError(promise: Promise<unknown>, status: number, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).status).toBe(status);
    expect((error as RequestError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('TeraBox device flow', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns an opaque handle and never exposes the device code to the browser', async () => {
    const { deps } = makeDeps();
    const started = await startTeraBoxDeviceFlow('user-1', deps);
    expect(started.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.qrCodeDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(JSON.stringify(started)).not.toContain('device-1');
  });

  it('keeps one active flow per user (a new start replaces the old one)', async () => {
    const { deps, store } = makeDeps();
    const first = await startTeraBoxDeviceFlow('user-1', deps);
    const second = await startTeraBoxDeviceFlow('user-1', deps);
    expect(store.size()).toBe(1);
    await expectRequestError(pollTeraBoxDeviceFlow('user-1', first.handle, deps), 404, 'DEVICE_FLOW_NOT_FOUND');
    await expect(pollTeraBoxDeviceFlow('user-1', second.handle, deps)).resolves.toMatchObject({ status: 'pending' });
  });

  it("refuses another user's handle exactly like an unknown one (no existence leak)", async () => {
    const { deps, calls } = makeDeps();
    const { handle } = await startTeraBoxDeviceFlow('user-1', deps);
    await expectRequestError(pollTeraBoxDeviceFlow('user-2', handle, deps), 404, 'DEVICE_FLOW_NOT_FOUND');
    await expectRequestError(pollTeraBoxDeviceFlow('user-2', 'x'.repeat(43), deps), 404, 'DEVICE_FLOW_NOT_FOUND');
    expect(calls.poll).toBe(0);
    // The owner is unaffected.
    await expect(pollTeraBoxDeviceFlow('user-1', handle, deps)).resolves.toMatchObject({ status: 'pending' });
  });

  it('rejects malformed handles without touching the store or TeraBox', async () => {
    const { deps, calls } = makeDeps();
    for (const bad of ['', 'short', 'a'.repeat(44), '../etc/passwd', 'a'.repeat(42) + '!']) {
      await expectRequestError(pollTeraBoxDeviceFlow('user-1', bad, deps), 404, 'DEVICE_FLOW_NOT_FOUND');
    }
    expect(calls.poll).toBe(0);
  });

  it('throttles polls to the interval TeraBox dictates', async () => {
    const { deps, calls, advance } = makeDeps();
    const { handle } = await startTeraBoxDeviceFlow('user-1', deps);
    expect(await pollTeraBoxDeviceFlow('user-1', handle, deps)).toEqual({ status: 'pending', retryAfterSeconds: 2 });
    expect(calls.poll).toBe(1);
    const early = await pollTeraBoxDeviceFlow('user-1', handle, deps);
    expect(early.status).toBe('pending');
    expect(calls.poll).toBe(1);
    advance(2_100);
    await pollTeraBoxDeviceFlow('user-1', handle, deps);
    expect(calls.poll).toBe(2);
  });

  it('serialises concurrent polls so a device code is exchanged once', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { deps, calls } = makeDeps({
      poll: async () => {
        await gate;
        return { status: 'authorized', tokens: TOKENS };
      },
    });
    const { handle } = await startTeraBoxDeviceFlow('user-1', deps);
    const first = pollTeraBoxDeviceFlow('user-1', handle, deps);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await pollTeraBoxDeviceFlow('user-1', handle, deps);
    expect(second.status).toBe('pending');
    release?.();
    expect(await first).toEqual({ status: 'connected', accountId: 'acct-1' });
    expect(calls.finalize).toBe(1);
  });

  it('finalises once and makes the handle single-use', async () => {
    const { deps, calls, advance } = makeDeps({ poll: async () => ({ status: 'authorized', tokens: TOKENS }) });
    const { handle } = await startTeraBoxDeviceFlow('user-1', deps);
    expect(await pollTeraBoxDeviceFlow('user-1', handle, deps)).toEqual({ status: 'connected', accountId: 'acct-1' });
    advance(5_000);
    await expectRequestError(pollTeraBoxDeviceFlow('user-1', handle, deps), 404, 'DEVICE_FLOW_NOT_FOUND');
    expect(calls.finalize).toBe(1);
  });

  it('expires sessions at the device code lifetime', async () => {
    const { deps, advance, store } = makeDeps();
    const { handle } = await startTeraBoxDeviceFlow('user-1', deps);
    advance(301_000);
    await expectRequestError(pollTeraBoxDeviceFlow('user-1', handle, deps), 404, 'DEVICE_FLOW_NOT_FOUND');
    expect(store.size()).toBe(0);
  });

  it('reports a missing server configuration with a stable code', async () => {
    const { deps } = makeDeps({
      loadApp: async () => {
        throw new RequestError(409, 'PROVIDER_NOT_CONFIGURED', 'TeraBox is not configured on this server.');
      },
    });
    await expectRequestError(startTeraBoxDeviceFlow('user-1', deps), 409, 'PROVIDER_NOT_CONFIGURED');
  });

  it('does not let a failed token exchange leave tokens or a locked session behind', async () => {
    let fail = true;
    const { deps, advance } = makeDeps({
      poll: async () => {
        if (fail) throw new Error('boom');
        return { status: 'pending' };
      },
    });
    const { handle } = await startTeraBoxDeviceFlow('user-1', deps);
    await expect(pollTeraBoxDeviceFlow('user-1', handle, deps)).rejects.toThrow('boom');
    fail = false;
    advance(2_100);
    await expect(pollTeraBoxDeviceFlow('user-1', handle, deps)).resolves.toMatchObject({ status: 'pending' });
  });
});
