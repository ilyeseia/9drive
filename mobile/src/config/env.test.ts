import { ConfigError, resolveApiBaseUrl } from './env';

describe('resolveApiBaseUrl', () => {
  it('accepts https and strips trailing slashes', () => {
    expect(resolveApiBaseUrl('https://drive.example.com/', false)).toEqual({
      apiBaseUrl: 'https://drive.example.com',
      insecureTransport: false,
    });
    expect(resolveApiBaseUrl('https://drive.example.com/api//', false).apiBaseUrl).toBe('https://drive.example.com/api');
  });

  it('rejects a missing value', () => {
    expect(() => resolveApiBaseUrl(undefined, true)).toThrow(ConfigError);
    expect(() => resolveApiBaseUrl('   ', true)).toThrow(expect.objectContaining({ reason: 'missing' }));
  });

  it('rejects malformed URLs and non-http(s) schemes', () => {
    expect(() => resolveApiBaseUrl('not a url', true)).toThrow(expect.objectContaining({ reason: 'invalid' }));
    expect(() => resolveApiBaseUrl('ftp://example.com', true)).toThrow(expect.objectContaining({ reason: 'invalid' }));
    expect(() => resolveApiBaseUrl('javascript:alert(1)', true)).toThrow(expect.objectContaining({ reason: 'invalid' }));
  });

  it('rejects credentials, query strings and fragments', () => {
    for (const bad of ['https://user:pw@example.com', 'https://example.com?token=1', 'https://example.com/#x']) {
      expect(() => resolveApiBaseUrl(bad, true)).toThrow(expect.objectContaining({ reason: 'invalid' }));
    }
  });

  it('allows plain http only in debug builds and flags it', () => {
    expect(resolveApiBaseUrl('http://10.0.2.2:4000', true)).toEqual({ apiBaseUrl: 'http://10.0.2.2:4000', insecureTransport: true });
  });

  it('refuses plain http in release builds', () => {
    expect(() => resolveApiBaseUrl('http://10.0.2.2:4000', false)).toThrow(expect.objectContaining({ reason: 'insecure' }));
    expect(() => resolveApiBaseUrl('http://example.com', false)).toThrow(expect.objectContaining({ reason: 'insecure' }));
  });
});
