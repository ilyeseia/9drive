import { MutationObserver, onlineManager } from '@tanstack/react-query';
import { createQueryClient } from './queryClient';

describe('createQueryClient', () => {
  afterEach(() => onlineManager.setOnline(true));

  it('does not hold a mutation back while offline: it runs (and can fail) immediately instead of being queued', async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient();
    const fn = jest.fn(async () => {
      throw new Error('offline');
    });
    const observer = new MutationObserver(client, { mutationFn: fn });
    await expect(observer.mutate()).rejects.toThrow('offline');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('pauses queries while offline instead of failing them, so cached data stays visible', async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient();
    client.setQueryData(['k'], 'cached');
    const fetcher = jest.fn(async () => 'live');
    void client.fetchQuery({ queryKey: ['k'], queryFn: fetcher, staleTime: 0 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetcher).not.toHaveBeenCalled();
    expect(client.getQueryData(['k'])).toBe('cached');
  });
});
