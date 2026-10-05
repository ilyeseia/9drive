import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ProviderError } from '../../providers/errors.js'
import { createFakeProvider } from '../../providers/fake.js'
import { ALL_CAPABILITIES, type ProviderContext, type UploadInput } from '../../providers/types.js'

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    credentials: { kind: 'api_key', apiKey: 'test-key' },
    account: {
      id: 'account-1',
      userId: 'user-1',
      provider: 'fake',
      providerAccountId: 'fake-account-0001',
      displayName: 'Fake Account',
      config: {},
    },
    logger: () => {},
    ...overrides,
  }
}

function uploadInput(fileName: string, content: string, parentId: string | null = null): UploadInput {
  const buffer = Buffer.from(content, 'utf8')
  return {
    stream: Readable.from([buffer]),
    fileName,
    mimeType: 'text/plain',
    sizeBytes: BigInt(buffer.byteLength),
    parentId,
  }
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  }
  return Buffer.concat(chunks)
}

describe('FakeProvider', () => {
  it('exposes contract identity and the full capability set by default', () => {
    const fake = createFakeProvider()
    expect(fake.id).toBe('fake')
    expect(fake.displayName).toBe('Fake Storage')
    expect(fake.authMode).toBe('api_key')
    expect(fake.capabilities.size).toBe(ALL_CAPABILITIES.length)
    expect(fake.getCapabilities()).toBe(fake.capabilities)
    expect(typeof fake.revokeShare).toBe('function')
  })

  it('round-trips an upload through a streamed download', async () => {
    const fake = createFakeProvider()
    const c = ctx()
    const uploaded = await fake.upload(c, uploadInput('a.txt', 'hello world'))
    expect(uploaded.sizeBytes).toBe(11n)
    expect(uploaded.resumeToken).toBeNull()

    const download = await fake.download(c, { remoteId: uploaded.remoteId })
    expect(download.sizeBytes).toBe(11n)
    expect(download.mimeType).toBe('text/plain')
    expect(download.range).toBeUndefined()
    await expect(collect(download.stream)).resolves.toEqual(Buffer.from('hello world'))
  })

  it('throws ERR_CAPABILITY_UNSUPPORTED for undeclared operations', async () => {
    const fake = createFakeProvider({ capabilities: ['upload', 'download', 'list'] })
    const c = ctx()
    expect(fake.capabilities.has('delete')).toBe(false)
    await expect(fake.delete(c, { remoteId: 'file-1' })).rejects.toBeInstanceOf(ProviderError)
    await expect(fake.delete(c, { remoteId: 'file-1' })).rejects.toMatchObject({ code: 'ERR_CAPABILITY_UNSUPPORTED', retryable: false })
    await expect(fake.createShare(c, { remoteId: 'file-1', visibility: 'public_read' })).rejects.toMatchObject({
      code: 'ERR_CAPABILITY_UNSUPPORTED',
    })
    const uploaded = await fake.upload(c, uploadInput('ok.txt', 'fine'))
    expect(uploaded.sizeBytes).toBe(4n)
  })

  it('reports account info and quota with bigint arithmetic', async () => {
    const fake = createFakeProvider({ quota: { totalBytes: 100n } })
    const c = ctx()
    const info = await fake.getAccountInfo(c)
    expect(info).toEqual({
      providerAccountId: 'fake-account-0001',
      email: 'fake@example.invalid',
      displayName: 'Fake Account',
      avatarUrl: null,
    })

    const before = await fake.getQuota(c)
    expect(before).toMatchObject({ totalBytes: 100n, usedBytes: 0n, availableBytes: 100n, trashBytes: null })

    await fake.upload(c, uploadInput('q.txt', '12345'))
    const after = await fake.getQuota(c)
    expect(after.usedBytes).toBe(5n)
    expect(after.availableBytes).toBe(95n)

    fake.setQuota({ totalBytes: null })
    const unlimited = await fake.getQuota(c)
    expect(unlimited.totalBytes).toBeNull()
    expect(unlimited.availableBytes).toBeNull()
  })

  it('rejects uploads past the quota with ERR_QUOTA_EXCEEDED', async () => {
    const fake = createFakeProvider({ quota: { totalBytes: 5n } })
    const c = ctx()
    await expect(fake.upload(c, uploadInput('big.txt', '0123456789'))).rejects.toMatchObject({
      code: 'ERR_QUOTA_EXCEEDED',
      retryable: false,
    })
    const quota = await fake.getQuota(c)
    expect(quota.usedBytes).toBe(0n)
    const accepted = await fake.upload(c, uploadInput('small.txt', 'abc'))
    expect(accepted.sizeBytes).toBe(3n)
  })

  it('pages listings with opaque cursors in deterministic name order', async () => {
    const fake = createFakeProvider()
    const c = ctx()
    for (const name of ['d.txt', 'b.txt', 'e.txt', 'a.txt', 'c.txt']) fake.seedFile({ name })

    const page1 = await fake.list(c, { parentId: null, limit: 2 })
    expect(page1.entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(typeof page1.nextCursor).toBe('string')

    const page2 = await fake.list(c, { parentId: null, limit: 2, cursor: page1.nextCursor })
    expect(page2.entries.map((entry) => entry.name)).toEqual(['c.txt', 'd.txt'])

    const page3 = await fake.list(c, { parentId: null, limit: 2, cursor: page2.nextCursor })
    expect(page3.entries.map((entry) => entry.name)).toEqual(['e.txt'])
    expect(page3.nextCursor).toBeNull()

    await expect(fake.list(c, { parentId: null, cursor: '!@#$%' })).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' })
    await expect(fake.list(c, { parentId: null, limit: 0 })).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' })
  })

  it('supports folder create/rename/move/copy/delete semantics', async () => {
    const fake = createFakeProvider()
    const c = ctx()
    const docs = await fake.createFolder(c, { name: 'docs', parentId: null })
    const docsAgain = await fake.createFolder(c, { name: 'docs', parentId: null })
    expect(docsAgain.remoteId).toBe(docs.remoteId)

    const child = await fake.createFolder(c, { name: 'child', parentId: docs.remoteId })
    const note = await fake.upload(c, uploadInput('note.txt', 'hi', docs.remoteId))

    const renamed = await fake.rename(c, { remoteId: note.remoteId, newName: 'note2.txt' })
    expect(renamed.name).toBe('note2.txt')
    await expect(fake.rename(c, { remoteId: note.remoteId, newName: '   ' })).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' })

    const archive = await fake.createFolder(c, { name: 'archive', parentId: null })
    const moved = await fake.move(c, { remoteId: note.remoteId, newParentId: archive.remoteId })
    expect(moved.parentId).toBe(archive.remoteId)

    await expect(fake.move(c, { remoteId: docs.remoteId, newParentId: docs.remoteId })).rejects.toMatchObject({
      code: 'ERR_INVALID_INPUT',
    })
    await expect(fake.move(c, { remoteId: docs.remoteId, newParentId: child.remoteId })).rejects.toMatchObject({
      code: 'ERR_INVALID_INPUT',
    })

    const copied = await fake.copy(c, { remoteId: docs.remoteId, newParentId: null, newName: 'docs-copy' })
    expect(copied.isFolder).toBe(true)
    expect(copied.name).toBe('docs-copy')
    const copiedListing = await fake.list(c, { parentId: copied.remoteId })
    expect(copiedListing.entries.map((entry) => entry.name)).toEqual(['child'])

    await fake.delete(c, { remoteId: copied.remoteId })
    await expect(fake.getMetadata(c, { remoteId: copied.remoteId })).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' })
    await expect(fake.getMetadata(c, { remoteId: child.remoteId })).resolves.toMatchObject({ remoteId: child.remoteId })

    await fake.delete(c, { remoteId: docs.remoteId })
    await expect(fake.getMetadata(c, { remoteId: docs.remoteId })).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' })
    await expect(fake.getMetadata(c, { remoteId: note.remoteId })).resolves.toMatchObject({ name: 'note2.txt' })
    await expect(fake.getMetadata(c, { remoteId: 'missing' })).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' })
  })

  it('serves byte ranges and rejects ranges outside the object', async () => {
    const fake = createFakeProvider()
    const c = ctx()
    const uploaded = await fake.upload(c, uploadInput('r.bin', '0123456789'))

    const ranged = await fake.download(c, { remoteId: uploaded.remoteId, range: { start: 2, end: 5 } })
    expect(ranged.range).toEqual({ start: 2, end: 5, total: 10 })
    await expect(collect(ranged.stream)).resolves.toEqual(Buffer.from('2345'))

    const tail = await fake.download(c, { remoteId: uploaded.remoteId, range: { start: 8 } })
    expect(tail.range).toEqual({ start: 8, end: 9, total: 10 })
    await expect(collect(tail.stream)).resolves.toEqual(Buffer.from('89'))

    const clamped = await fake.download(c, { remoteId: uploaded.remoteId, range: { start: 7, end: 99 } })
    expect(clamped.range).toEqual({ start: 7, end: 9, total: 10 })

    await expect(fake.download(c, { remoteId: uploaded.remoteId, range: { start: 99 } })).rejects.toMatchObject({
      code: 'ERR_INVALID_INPUT',
    })
    const folder = fake.seedFolder({ name: 'not-a-file' })
    await expect(fake.download(c, { remoteId: folder.remoteId })).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' })
  })

  it('creates and revokes shares idempotently', async () => {
    const fake = createFakeProvider()
    const c = ctx()
    const file = fake.seedFile({ name: 'pub.txt' })
    const share = await fake.createShare(c, { remoteId: file.remoteId, visibility: 'public_read' })
    expect(share.url).toContain(file.remoteId)
    expect(share.visibility).toBe('public_read')
    expect(share.expiresAt).toBeNull()

    const expiring = await fake.createShare(c, {
      remoteId: file.remoteId,
      visibility: 'private',
      expiresAt: '2026-12-31T00:00:00.000Z',
    })
    expect(expiring.expiresAt).toBe('2026-12-31T00:00:00.000Z')

    await fake.revokeShare(c, { remoteId: file.remoteId })
    await fake.revokeShare(c, { remoteId: file.remoteId })
    await expect(fake.getMetadata(c, { remoteId: file.remoteId })).resolves.toMatchObject({ remoteId: file.remoteId })
  })

  it('injects a bounded number of retryable failures before recovering', async () => {
    const fake = createFakeProvider()
    const c = ctx()
    fake.failNext('upload', { code: 'ERR_RATE_LIMITED', message: 'slow down', times: 2 })

    await expect(fake.upload(c, uploadInput('a.txt', '1'))).rejects.toMatchObject({
      code: 'ERR_RATE_LIMITED',
      retryable: true,
      message: 'slow down',
    })
    await expect(fake.upload(c, uploadInput('a.txt', '1'))).rejects.toMatchObject({ code: 'ERR_RATE_LIMITED' })

    const accepted = await fake.upload(c, uploadInput('a.txt', '1'))
    expect(accepted.sizeBytes).toBe(1n)
    expect(fake.callCount('upload')).toBe(3)
    expect(fake.callLog.filter((call) => !call.ok)).toHaveLength(2)
    expect(fake.callLog.filter((call) => call.ok).map((call) => call.operation)).toContain('upload')

    fake.failNext('*', { code: 'ERR_AUTH_REVOKED' })
    await expect(fake.getQuota(c)).rejects.toMatchObject({ code: 'ERR_AUTH_REVOKED', retryable: false })

    fake.failNext('healthCheck', { code: 'ERR_UPSTREAM_UNAVAILABLE', times: Number.POSITIVE_INFINITY })
    await expect(fake.healthCheck(c)).rejects.toMatchObject({ code: 'ERR_UPSTREAM_UNAVAILABLE', retryable: true })
    await expect(fake.healthCheck(c)).rejects.toMatchObject({ code: 'ERR_UPSTREAM_UNAVAILABLE', retryable: true })

    fake.clearFailures()
    await expect(fake.healthCheck(c)).resolves.toMatchObject({ state: 'healthy' })
  })

  it('applies configurable latency for timing tests', async () => {
    const fake = createFakeProvider({ latencyMs: 40 })
    const c = ctx()
    const startedAt = Date.now()
    await fake.healthCheck(c)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35)
    fake.setLatency(0)
    expect(fake.currentLatencyMs).toBe(0)
    expect(() => fake.setLatency(-1)).toThrow(ProviderError)
  })

  it('reports injected health state', async () => {
    const fake = createFakeProvider({ health: { state: 'degraded', message: 'slow upstream' } })
    const c = ctx()
    const health = await fake.healthCheck(c)
    expect(health.state).toBe('degraded')
    expect(health.message).toBe('slow upstream')
    expect(health.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(health.latencyMs).toBeGreaterThanOrEqual(0)

    fake.setHealth({ state: 'unauthorized', message: 'token revoked' })
    await expect(fake.healthCheck(c)).resolves.toMatchObject({ state: 'unauthorized', message: 'token revoked' })
  })

  it('fails fast when the abort signal is already aborted', async () => {
    const fake = createFakeProvider()
    const c = ctx({ signal: AbortSignal.abort() })
    await expect(fake.list(c, { parentId: null })).rejects.toMatchObject({ code: 'ERR_TIMEOUT' })
  })

  it('validates required inputs with ERR_INVALID_INPUT', async () => {
    const fake = createFakeProvider()
    const c = ctx()
    await expect(fake.upload(c, uploadInput('   ', 'x'))).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' })
    await expect(fake.createFolder(c, { name: '', parentId: null })).rejects.toMatchObject({ code: 'ERR_INVALID_INPUT' })
    const orphan = await fake.upload(c, uploadInput('loose.txt', 'x', null))
    expect(orphan.remoteId).toBeTruthy()
    await expect(fake.upload(c, uploadInput('x.txt', 'x', 'missing-folder'))).rejects.toMatchObject({ code: 'ERR_NOT_FOUND' })
  })

  it('produces identical ids, timestamps and cursors across fresh instances', async () => {
    const run = async () => {
      const fake = createFakeProvider()
      const c = ctx()
      const folder = await fake.createFolder(c, { name: 'shared', parentId: null })
      const file = await fake.upload(c, uploadInput('data.bin', 'payload', folder.remoteId))
      const share = await fake.createShare(c, { remoteId: file.remoteId, visibility: 'public_read' })
      const listing = await fake.list(c, { parentId: folder.remoteId })
      const health = await fake.healthCheck(c)
      return { folder, file, share, listing, health }
    }
    const first = await run()
    const second = await run()
    expect(second).toEqual(first)
  })

  it('resets storage, failures and call logs back to constructor defaults', async () => {
    const fake = createFakeProvider({ quota: { totalBytes: 10n } })
    const c = ctx()
    fake.seedFile({ name: 'seeded.txt' })
    await fake.upload(c, uploadInput('one.txt', 'x'))
    fake.failNext('upload')
    expect(fake.listSeed()).toHaveLength(2)
    expect(fake.callCount()).toBeGreaterThan(0)

    fake.reset()
    expect(fake.listSeed()).toHaveLength(0)
    expect(fake.callCount()).toBe(0)
    await expect(fake.upload(c, uploadInput('two.txt', 'yy'))).resolves.toMatchObject({ sizeBytes: 2n })
    const quota = await fake.getQuota(c)
    expect(quota.totalBytes).toBe(10n)
  })
})
