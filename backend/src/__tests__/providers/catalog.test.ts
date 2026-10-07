import { describe, expect, it } from 'vitest'
import { PROVIDER_CATALOG, catalog } from '../../providers/catalog.js'
import { isCapability } from '../../providers/types.js'

const EXPECTED_STATUSES: Record<string, string> = {
  google_drive: 'SUPPORTED',
  s3: 'SUPPORTED',
  dropbox: 'SUPPORTED',
  onedrive: 'SUPPORTED',
  pcloud: 'SUPPORTED',
  box: 'PLANNED',
  yandex_disk: 'PLANNED',
  koofr: 'PLANNED',
  mega: 'RESEARCH_REQUIRED',
  mediafire: 'PLANNED',
  terabox: 'SUPPORTED',
  proton_drive: 'RESEARCH_REQUIRED',
  icedrive: 'UNSUPPORTED',
  sync: 'UNSUPPORTED',
  idrive: 'UNSUPPORTED',
  internxt: 'VIA_S3',
  idrive_e2: 'VIA_S3',
  backblaze_b2: 'VIA_S3',
  cloudflare_r2: 'VIA_S3',
  minio: 'VIA_S3',
  wasabi: 'VIA_S3',
}

describe('provider catalog', () => {
  it('contains exactly the contract §2 provider ids with accurate statuses', () => {
    const statuses = Object.fromEntries(PROVIDER_CATALOG.map((entry) => [entry.id, entry.status]))
    expect(statuses).toEqual(EXPECTED_STATUSES)
  })

  it('explains every entry that has no working adapter', () => {
    for (const entry of PROVIDER_CATALOG) {
      if (entry.status === 'SUPPORTED') continue
      expect(entry.notes, `${entry.id} must document why`).toBeTruthy()
      expect((entry.notes ?? '').length, `${entry.id} notes too short`).toBeGreaterThan(20)
    }
  })

  it('keeps capability declarations truthful', () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(new Set(entry.capabilities).size, entry.id).toBe(entry.capabilities.length)
      for (const capability of entry.capabilities) expect(isCapability(capability), `${entry.id}:${capability}`).toBe(true)
      if (['PLANNED', 'RESEARCH_REQUIRED', 'UNSUPPORTED'].includes(entry.status)) {
        expect(entry.capabilities, entry.id).toEqual([])
      }
      if (entry.status === 'SUPPORTED') {
        for (const required of ['upload', 'download', 'list', 'getQuota', 'healthCheck']) {
          expect(entry.capabilities, `${entry.id}:${required}`).toContain(required)
        }
      }
    }
  })

  it('gives every VIA_S3 preset an S3-shaped entry', () => {
    const presets = PROVIDER_CATALOG.filter((entry) => entry.status === 'VIA_S3')
    expect(presets.map((entry) => entry.id).sort()).toEqual([
      'backblaze_b2',
      'cloudflare_r2',
      'idrive_e2',
      'internxt',
      'minio',
      'wasabi',
    ])
    for (const entry of presets) {
      expect(entry.authMode, entry.id).toBe('access_key')
      expect(entry.s3Preset, entry.id).toBeTruthy()
      expect(entry.s3Preset?.endpoint, entry.id).toMatch(/^https?:\/\//)
      expect(typeof entry.s3Preset?.forcePathStyle, entry.id).toBe('boolean')
      expect(entry.s3Preset?.region, entry.id).toBeTruthy()
      expect(entry.capabilities.length, entry.id).toBeGreaterThan(0)
    }
    expect(catalog.get('minio')?.s3Preset?.forcePathStyle).toBe(true)
  })

  it('matches the catalog entry shape returned by GET /providers/catalog', () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(typeof entry.id).toBe('string')
      expect(typeof entry.displayName).toBe('string')
      expect(['oauth2', 'access_key', 'api_key'], entry.id).toContain(entry.authMode)
      expect(Object.isFrozen(entry), entry.id).toBe(true)
      expect(Object.isFrozen(PROVIDER_CATALOG), 'catalog array').toBe(true)
    }
  })

  it('supports the module-level capability checks from the contract', () => {
    expect(catalog.get('google_drive')?.status).toBe('SUPPORTED')
    expect(catalog.get('mega')?.status).toBe('RESEARCH_REQUIRED')
    expect(catalog.has('s3')).toBe(true)
    expect(catalog.has('not_a_provider')).toBe(false)
    expect(catalog.list()).toHaveLength(PROVIDER_CATALOG.length)
    expect(catalog.require('dropbox').id).toBe('dropbox')
    expect(() => catalog.require('not_a_provider')).toThrow()
    expect(catalog.supported().map((entry) => entry.id)).toEqual([
      'google_drive',
      's3',
      'dropbox',
      'onedrive',
      'pcloud',
      'terabox',
    ])
  })
})
