import { QueryClient } from '@tanstack/react-query';

/**
 * One QueryClient per app instance.
 *  - Queries: no automatic retry here (the API client already retries safe requests with bounded backoff). While
 *    offline they pause and keep showing their last data.
 *  - Mutations: `networkMode: 'always'`, so a change never waits silently for a connection and then fires later.
 *    Queued, delayed destructive actions would be surprising and unsafe; offline, a mutation fails at once with a
 *    clear "offline" error and the user decides what to do.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 15_000 },
      mutations: { retry: false, networkMode: 'always' },
    },
  });
}
