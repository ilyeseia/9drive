import { log, redact, redactString, setLogSink, setVerbose, type LogEvent } from './logger';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';

describe('redaction', () => {
  it('masks bearer tokens, JWTs, signed-URL parameters and API keys inside strings', () => {
    expect(redactString(`Authorization: Bearer ${JWT}`)).not.toContain(JWT);
    expect(redactString(`got ${JWT} back`)).toBe('got [redacted-jwt] back');
    expect(redactString('https://x.test/f?X-Amz-Signature=abc123&expires=5')).toBe('https://x.test/f?X-Amz-Signature=[redacted]&expires=5');
    expect(redactString('https://x.test/dl?token=SECRET&a=1')).toContain('token=[redacted]');
    expect(redactString('key sk-abcdefghijklmnop1234')).toBe('key [redacted-key]');
  });

  it('masks sensitive object keys at any depth and never prints values', () => {
    const out = redact({
      user: 'a',
      password: 'hunter2',
      headers: { Authorization: 'Bearer x', accept: 'json' },
      nested: { refreshToken: 'r', ok: 1 },
    }) as Record<string, any>;
    expect(out.password).toBe('[redacted]');
    expect(out.headers.Authorization).toBe('[redacted]');
    expect(out.headers.accept).toBe('json');
    expect(out.nested.refreshToken).toBe('[redacted]');
    expect(out.nested.ok).toBe(1);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('bounds size and depth and handles cycles of depth gracefully', () => {
    expect(redactString('a'.repeat(2000)).length).toBeLessThan(600);
    const deep: any = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
    expect(redact(new Error(`failed with Bearer ${JWT}`))).toEqual({ name: 'Error', message: expect.not.stringContaining(JWT) });
  });
});

describe('log', () => {
  const events: LogEvent[] = [];
  beforeEach(() => {
    events.length = 0;
    setLogSink((e) => events.push(e));
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    setLogSink(null);
    setVerbose(false);
    jest.restoreAllMocks();
  });

  it('sends only redacted events to the sink', () => {
    log.warn(`bad token Bearer ${JWT}`, { authorization: 'Bearer abc', path: '/files' });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(JWT);
    expect(JSON.stringify(events[0])).not.toContain('abc');
    expect(events[0]?.context).toEqual({ authorization: '[redacted]', path: '/files' });
  });

  it('drops debug/info when not verbose, keeps warn/error', () => {
    log.debug('d');
    log.info('i');
    expect(events).toHaveLength(0);
    log.warn('w');
    log.error('e');
    expect(events.map((e) => e.level)).toEqual(['warn', 'error']);
    setVerbose(true);
    log.debug('d2');
    expect(events.at(-1)?.level).toBe('debug');
  });
});
