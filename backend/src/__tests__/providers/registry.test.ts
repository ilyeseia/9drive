import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../config/prisma.js'
import { PROVIDER_CATALOG, catalog } from '../../providers/catalog.js'
import { ProviderError } from '../../providers/errors.js'
import { createFakeProvider } from '../../providers/fake.js'
import {
  ProviderRegistry,
  loadProviderCapabilityRows,
  loadSupportedCapabilities,
  recordProviderHealth,
  registry,
  seedProviderCapabilities,
  truncateStoredMessage,
} from '../../providers/registry.js'
import { ALL_CAPABILITIES, isCapability } from '../../providers/types.js'

describe('ProviderRegistry', () => {
  it('registers, resolves and removes providers', () => {
    const local = new ProviderRegistry()
    const fake = createFakeProvider()
    local.register(fake)

    expect(local.has('fake')).toBe(true)
    expect(local.get('fake')).toBe(fake)
    expect(local.tryGet('fake')).toBe(fake)
    expect(local.all()).toEqual([fake])
    expect(local.supportedIds()).toEqual(['fake'])
    expect(local.unregister('fake')).toBe(true)
    expect(local.tryGet('fake')).toBeNull()
    expect(local.all()).toEqual([])
  })

  it('throws ERR_NOT_FOUND for unknown providers', () => {
    const local = new ProviderRegistry()
    expect(() => local.get('nope')).toThrow(ProviderError)
    try {
      local.get('nope')
    } catch (err) {
      expect(ProviderError.is(err)).toBe(true)
      expect((err as ProviderError).code).toBe('ERR_NOT_FOUND')
      expect((err as ProviderError).status).toBe(404)
    }
    expect(local.tryGet('nope')).toBeNull()
    expect(() => local.capabilities('nope')).toThrow(ProviderError)
  })

  it('rejects registration without a provider id', () => {
    const local = new ProviderRegistry()
    expect(() => local.register(createFakeProvider({ id: '   ' }))).toThrow(ProviderError)
    expect(() =>
      local.register({
        id: '',
        displayName: 'x',
        authMode: 'api_key',
        capabilities: new Set(),
      } as never),
    ).toThrow(ProviderError)
  })

  it('replaces an existing registration for the same id', () => {
    const local = new ProviderRegistry()
    const first = createFakeProvider({ displayName: 'First' })
    const second = createFakeProvider({ displayName: 'Second' })
    local.register(first)
    local.register(second)
    expect(local.all()).toHaveLength(1)
    expect(local.get('fake')).toBe(second)
  })

  it('exposes capabilities through the contract queries', () => {
    const local = new ProviderRegistry()
    local.register(createFakeProvider({ capabilities: ['upload', 'download', 'healthCheck'] }))
    expect(local.capabilities('fake').has('upload')).toBe(true)
    expect(local.capabilities('fake').has('createShare')).toBe(false)
    expect(local.hasCapability('fake', 'download')).toBe(true)
    expect(local.hasCapability('fake', 'search')).toBe(false)
  })

  it('filters supportedIds by catalog status', () => {
    const local = new ProviderRegistry()
    local.register(createFakeProvider({ id: 'fake' }))
    local.register(createFakeProvider({ id: 'google_drive' }))
    local.register(createFakeProvider({ id: 'box' }))
    local.register(createFakeProvider({ id: 'icedrive' }))
    expect(local.supportedIds().sort()).toEqual(['fake', 'google_drive'])
    local.clear()
    expect(local.supportedIds()).toEqual([])
  })

  it('resolves through the singleton registry export', () => {
    const fake = createFakeProvider({ id: 'singleton-probe' })
    registry.register(fake)
    try {
      expect(registry.get('singleton-probe')).toBe(fake)
      expect(registry.supportedIds()).toContain('singleton-probe')
    } finally {
      registry.unregister('singleton-probe')
    }
    expect(registry.tryGet('singleton-probe')).toBeNull()
  })
})

describe('truncateStoredMessage', () => {
  it('caps stored upstream messages at 500 characters', () => {
    expect(truncateStoredMessage('short')).toBe('short')
    expect(truncateStoredMessage('x'.repeat(500))).toHaveLength(500)
    expect(truncateStoredMessage('y'.repeat(501))).toHaveLength(500)
    expect(truncateStoredMessage(null)).toBeNull()
    expect(truncateStoredMessage(undefined)).toBeNull()
  })
})

describe('provider persistence (postgres)', () => {
  let dbOk = false

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`
      dbOk = true
    } catch {
      dbOk = false
    }
  })

  afterAll(async () => {
    if (!dbOk) return
    await prisma.providerHealth.deleteMany({ where: { provider: 'fake_probe' } })
  })

  it('upserts the static catalog into provider_capabilities idempotently', async (testCtx) => {
    if (!dbOk) testCtx.skip()
    const first = await seedProviderCapabilities()
    expect(first.providers).toBe(PROVIDER_CATALOG.length)
    expect(first.rows).toBe(PROVIDER_CATALOG.length * ALL_CAPABILITIES.length)

    const second = await seedProviderCapabilities()
    expect(second).toEqual(first)

    const googleRows = await loadProviderCapabilityRows('google_drive')
    expect(googleRows).toHaveLength(ALL_CAPABILITIES.length)
    expect(googleRows.every((row) => row.supported)).toBe(true)

    const unsupportedRows = await loadProviderCapabilityRows('icedrive')
    expect(unsupportedRows).toHaveLength(ALL_CAPABILITIES.length)
    expect(unsupportedRows.some((row) => row.supported)).toBe(false)

    const dropboxSearch = await prisma.providerCapability.findUnique({
      where: { provider_capability: { provider: 'dropbox', capability: 'search' } },
    })
    expect(dropboxSearch?.supported).toBe(true)
  }, 20000)

  it('refreshes supported flags without clobbering manual notes', async (testCtx) => {
    if (!dbOk) testCtx.skip()
    await prisma.providerCapability.upsert({
      where: { provider_capability: { provider: 's3', capability: 'search' } },
      create: { provider: 's3', capability: 'search', supported: true, notes: 'keep me' },
      update: { supported: true, notes: 'keep me' },
    })

    await seedProviderCapabilities()

    const row = await prisma.providerCapability.findUnique({
      where: { provider_capability: { provider: 's3', capability: 'search' } },
    })
    expect(row?.supported).toBe(false)
    expect(row?.notes).toBe('keep me')
  }, 20000)

  it('reads back only declared capabilities', async (testCtx) => {
    if (!dbOk) testCtx.skip()
    const capabilities = await loadSupportedCapabilities('s3')
    expect(capabilities).toContain('upload')
    expect(capabilities).toContain('createShare')
    expect(capabilities).not.toContain('search')
    expect(capabilities.every(isCapability)).toBe(true)

    const empty = await loadSupportedCapabilities('proton_drive')
    expect(empty).toEqual([])
  }, 20000)

  it('upserts provider_health rows and truncates messages', async (testCtx) => {
    if (!dbOk) testCtx.skip()
    const created = await recordProviderHealth({ provider: 'fake_probe', state: 'healthy', latencyMs: 5, message: 'ok' })
    expect(created.provider).toBe('fake_probe')
    expect(created.state).toBe('healthy')

    const updated = await recordProviderHealth({
      provider: 'fake_probe',
      state: 'degraded',
      latencyMs: 120,
      message: 'z'.repeat(600),
      checkedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(updated.id).toBe(created.id)
    expect(updated.state).toBe('degraded')
    expect(updated.message).toHaveLength(500)
    expect(updated.checkedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'))

    const probeRows = await prisma.providerHealth.findMany({ where: { provider: 'fake_probe' } })
    expect(probeRows).toHaveLength(1)

    const accountId = '00000000-0000-4000-8000-0000000000ff'
    const accountRow = await recordProviderHealth({ provider: 'fake_probe', connectedAccountId: accountId, state: 'healthy' })
    const accountRowAgain = await recordProviderHealth({
      provider: 'fake_probe',
      connectedAccountId: accountId,
      state: 'unreachable',
      message: 'down',
    })
    expect(accountRowAgain.id).toBe(accountRow.id)
    expect(accountRowAgain.connectedAccountId).toBe(accountId)
    expect(accountRowAgain.state).toBe('unreachable')
  }, 20000)
})

describe('catalog accessor used by modules', () => {
  it('returns entries with the contract shape', () => {
    const entry = catalog.get('google_drive')
    expect(entry?.status).toBe('SUPPORTED')
    expect(entry?.authMode).toBe('oauth2')
    expect(Array.isArray(entry?.capabilities)).toBe(true)
    expect(catalog.get('does-not-exist')).toBeNull()
    expect(catalog.has('s3')).toBe(true)
    expect(() => catalog.require('does-not-exist')).toThrow()
    expect(catalog.supported().map((supported) => supported.id)).toEqual([
      'google_drive',
      's3',
      'dropbox',
      'onedrive',
      'pcloud',
      'terabox',
    ])
  })
})
