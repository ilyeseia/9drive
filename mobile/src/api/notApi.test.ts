import { ApiClient } from './client';
import { ApiError } from './errors';

const html = '<!doctype html><html><head><title>9Drive</title></head><body>app</body></html>';

function clientAnswering(status: number, text: string) {
  const fetchImpl = (async () => new Response(text, { status })) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: 'https://host.test/', fetchImpl, sleep: async () => undefined, random: () => 0.5 });
}

describe('wrong server address', () => {
  it.each([
    [200, html],
    [405, '<html><head><title>405 Not Allowed</title></head></html>'],
    [404, `\n  ${html}`],
  ])('reports "not the API" when a web page answers with status %i', async (status, body) => {
    const error = await clientAnswering(status, body)
      .requestVoid({ method: 'POST', path: '/auth/login', body: {}, auth: false })
      .catch((e: unknown) => e);
    expect(ApiError.is(error)).toBe(true);
    expect(error).toMatchObject({ kind: 'not_api', status });
    // It is a configuration problem, never worth retrying automatically.
    expect((error as ApiError).transient).toBe(false);
  });

  it('does not misclassify real JSON error bodies', async () => {
    const error = await clientAnswering(401, JSON.stringify({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' }))
      .requestVoid({ method: 'POST', path: '/auth/login', body: {}, auth: false })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'unauthorized', code: 'AUTH_INVALID_CREDENTIALS' });
  });
});
