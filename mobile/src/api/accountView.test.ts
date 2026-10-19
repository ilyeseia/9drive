import { accountViewSchema } from './endpoints/providers';

const base = {
  id: 'a1',
  provider: 's3',
  displayName: 'Bucket',
  email: 'b (S3)',
  status: 'connected',
  lastError: null,
  capabilities: ['upload'],
  health: null,
  lastSyncedAt: null,
  routingEnabled: null,
  experimental: false,
  quotaPolicy: 'optional',
};

describe('account view contract', () => {
  it('accepts negative free space (used above the configured total) and shows it as zero', () => {
    const parsed = accountViewSchema.parse({ ...base, quota: { totalBytes: '100', usedBytes: '150', availableBytes: '-50' } });
    expect(parsed.quota?.availableBytes).toBe('0');
  });

  it('keeps normal and unknown values intact', () => {
    expect(
      accountViewSchema.parse({ ...base, quota: { totalBytes: '100', usedBytes: '40', availableBytes: '60' } }).quota?.availableBytes,
    ).toBe('60');
    expect(
      accountViewSchema.parse({ ...base, quota: { totalBytes: null, usedBytes: '0', availableBytes: null } }).quota?.availableBytes,
    ).toBeNull();
  });

  it('still rejects garbage', () => {
    expect(() => accountViewSchema.parse({ ...base, quota: { totalBytes: '1', usedBytes: 'x', availableBytes: '1' } })).toThrow();
  });
});
