import { afterAll, describe, expect, it } from 'vitest'
import { createS3Client } from '../../modules/s3/s3.service.js'
import { assertFetchAllowed, assertResolvedAddressesAllowed, assertUrlAllowed, isBlockedIp, sanitizeUrlForDisplay } from '../../utils/ssrf.js'

afterAll(() => {
  delete process.env.SSRF_ALLOWLIST
})

function expectSsrfBlocked(run: () => unknown) {
  let caught: { code?: string } | undefined
  try {
    run()
  } catch (error) {
    caught = error as { code?: string }
  }
  expect(caught).toBeDefined()
  expect(caught!.code).toBe('ERR_SSRF_BLOCKED')
}

describe('assertUrlAllowed', () => {
  const blockedUrls = [
    'http://169.254.169.254/latest/meta-data/',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://localhost/admin',
    'https://example.com:22/',
    'ftp://example.com/file',
    'https://user:pass@example.com/',
    'https://example.invalid/path#fragment',
  ]

  for (const url of blockedUrls) {
    it(`rejects ${url}`, () => {
      expectSsrfBlocked(() => assertUrlAllowed(url))
    })
  }

  it('accepts a plain https URL without credentials', () => {
    expect(assertUrlAllowed('https://example.com/path').hostname).toBe('example.com')
  })

  it('accepts a port-allow-listed custom endpoint host', () => {
    expect(assertUrlAllowed('https://objects.example.com:9000/bucket').port).toBe('9000')
  })
})

describe('assertFetchAllowed / address gate', () => {
  const blockedTargets = [
    'https://10.0.0.5/',
    'https://127.0.0.1/',
    'https://169.254.169.254/',
    'https://192.168.1.10/webhook',
    'https://[::1]/',
  ]

  for (const url of blockedTargets) {
    it(`rejects ${url} before any connection is opened`, async () => {
      await expect(assertFetchAllowed(url)).rejects.toMatchObject({ code: expect.stringMatching(/ERR_SSRF_BLOCKED|ERR_UPSTREAM_UNAVAILABLE/) })
    })
  }

  it('rejects webhook-style http URLs', async () => {
    await expect(assertFetchAllowed('http://192.168.10.5/hook')).rejects.toMatchObject({ code: 'ERR_SSRF_BLOCKED' })
  })

  it('flags private, loopback and metadata addresses', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true)
    expect(isBlockedIp('10.1.2.3')).toBe(true)
    expect(isBlockedIp('169.254.169.254')).toBe(true)
    expect(isBlockedIp('::1')).toBe(true)
    expect(isBlockedIp('8.8.8.8')).toBe(false)
  })

  it('honours SSRF_ALLOWLIST for operator-approved hosts', async () => {
    process.env.SSRF_ALLOWLIST = '10.99.99.99'
    await expect(assertResolvedAddressesAllowed('10.99.99.99')).resolves.toBeUndefined()
  })
})

describe('S3 endpoint gate', () => {
  const baseConfig = {
    region: 'us-east-1',
    forcePathStyle: true,
    accessKeyIdEncrypted: 'not-a-real-ciphertext',
    secretAccessKeyEncrypted: 'not-a-real-ciphertext',
  }

  it('refuses to build a client for a metadata endpoint', async () => {
    const config = { ...baseConfig, endpoint: 'https://169.254.169.254' } as Parameters<typeof createS3Client>[0]
    await expect(createS3Client(config)).rejects.toMatchObject({ code: 'ERR_SSRF_BLOCKED' })
  })

  it('refuses to build a client for a private network endpoint', async () => {
    const config = { ...baseConfig, endpoint: 'https://10.0.0.8:9000' } as Parameters<typeof createS3Client>[0]
    await expect(createS3Client(config)).rejects.toMatchObject({ code: 'ERR_SSRF_BLOCKED' })
  })

  it('refuses plaintext http endpoints by default', async () => {
    const config = { ...baseConfig, endpoint: 'http://objects.example.com' } as Parameters<typeof createS3Client>[0]
    await expect(createS3Client(config)).rejects.toMatchObject({ code: 'ERR_SSRF_BLOCKED' })
  })
})

describe('sanitizeUrlForDisplay', () => {
  it('strips query strings and fragments', () => {
    expect(sanitizeUrlForDisplay('https://example.com/x?token=abc#frag')).toBe('https://example.com/x')
  })
})
