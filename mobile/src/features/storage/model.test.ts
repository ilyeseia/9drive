import {
  healthSeverity,
  isInsecureEndpoint,
  isKnownMode,
  megabytesToBytes,
  moveId,
  orderByPriority,
  providerLabel,
  quotaOf,
  statusSeverity,
  summarize,
  validateS3,
} from './model';

const acct = (quota: { total: string | null; used: string; available?: string | null } | null) => ({
  quota: quota ? { totalBytes: quota.total, usedBytes: quota.used, availableBytes: quota.available ?? null } : null,
});

describe('quotaOf', () => {
  it('never invents capacity: unknown stays unknown', () => {
    expect(quotaOf(acct(null))).toEqual({ kind: 'unknown' });
  });

  it('reports used-only when no total is known (or it is zero)', () => {
    expect(quotaOf(acct({ total: null, used: '500' }))).toEqual({ kind: 'usedOnly', used: 500 });
    expect(quotaOf(acct({ total: '0', used: '500' }))).toEqual({ kind: 'usedOnly', used: 500 });
  });

  it('computes fraction and free space, clamped', () => {
    expect(quotaOf(acct({ total: '1000', used: '250', available: '700' }))).toEqual({
      kind: 'known',
      used: 250,
      total: 1000,
      available: 700,
      fraction: 0.25,
    });
    expect(quotaOf(acct({ total: '1000', used: '250' }))).toMatchObject({ available: 750 });
    expect(quotaOf(acct({ total: '1000', used: '5000' }))).toMatchObject({ fraction: 1, available: 0 });
  });
});

describe('summarize', () => {
  it('counts only accounts with reported capacity and says how many were skipped', () => {
    const out = summarize([
      acct({ total: '1000', used: '100' }),
      acct({ total: '2000', used: '300' }),
      acct(null),
      acct({ total: null, used: '9' }),
    ]);
    expect(out).toEqual({ total: 3000, used: 400, counted: 2, skipped: 2 });
  });
});

describe('severity', () => {
  it('maps statuses and health states, defaulting to unknown', () => {
    expect(statusSeverity('connected')).toBe('ok');
    expect(statusSeverity('error')).toBe('bad');
    expect(statusSeverity('pending')).toBe('warn');
    expect(statusSeverity('weird')).toBe('unknown');
    expect(healthSeverity('healthy')).toBe('ok');
    expect(healthSeverity('degraded')).toBe('warn');
    expect(healthSeverity('unreachable')).toBe('bad');
    expect(healthSeverity(undefined)).toBe('unknown');
  });
});

describe('priority helpers', () => {
  const accounts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('orders by the saved list, unlisted last, stale ids ignored', () => {
    expect(orderByPriority(accounts, ['c', 'zzz', 'a']).map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(orderByPriority(accounts, []).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('moves ids within bounds only', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a'], 'missing', 1)).toEqual(['a']);
  });
  it('recognises only modes this app version knows', () => {
    expect(isKnownMode('priority')).toBe(true);
    expect(isKnownMode('future_mode')).toBe(false);
  });
});

describe('megabytesToBytes', () => {
  it('accepts positive decimals (comma or dot) and rejects the rest', () => {
    expect(megabytesToBytes('1')).toBe(1048576);
    expect(megabytesToBytes('1,5')).toBe(1572864);
    expect(megabytesToBytes(' 0.5 ')).toBe(524288);
    for (const bad of ['', '0', '-1', 'abc', '1e9', '1.2.3', '99999999999']) expect(megabytesToBytes(bad)).toBeNull();
  });
});

describe('providerLabel', () => {
  it('prefers the server catalog, then a built-in map, then the raw id', () => {
    expect(providerLabel('s3', [{ id: 's3', displayName: 'Custom S3' }])).toBe('Custom S3');
    expect(providerLabel('google_drive')).toBe('Google Drive');
    expect(providerLabel('mystery')).toBe('mystery');
  });
});

describe('validateS3', () => {
  const ok = { name: 'n', bucket: 'b', region: 'r', endpoint: '', accessKeyId: 'k', secretAccessKey: 's' };
  it('requires the essential fields', () => {
    expect(validateS3(ok)).toEqual({});
    expect(Object.keys(validateS3({ ...ok, name: ' ', bucket: '', region: '', accessKeyId: '', secretAccessKey: '' })).sort()).toEqual([
      'accessKeyId',
      'bucket',
      'name',
      'region',
      'secretAccessKey',
    ]);
  });
  it('rejects malformed endpoints and embedded credentials, allows http (the server decides) but flags it', () => {
    expect(validateS3({ ...ok, endpoint: 'https://s3.example.com' })).toEqual({});
    expect(validateS3({ ...ok, endpoint: 'not a url' }).endpoint).toBe('errEndpointInvalid');
    expect(validateS3({ ...ok, endpoint: 'ftp://x.example' }).endpoint).toBe('errEndpointInvalid');
    expect(validateS3({ ...ok, endpoint: 'https://user:pw@x.example' }).endpoint).toBe('errEndpointInvalid');
    expect(validateS3({ ...ok, endpoint: 'http://minio.lan:9000' })).toEqual({});
    expect(isInsecureEndpoint('http://minio.lan:9000')).toBe(true);
    expect(isInsecureEndpoint('https://s3.example.com')).toBe(false);
    expect(isInsecureEndpoint('')).toBe(false);
  });
});
