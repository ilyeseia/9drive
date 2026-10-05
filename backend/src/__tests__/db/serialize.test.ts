import { describe, expect, it } from 'vitest'
import { jsonSafe, serializeBigInt } from '../../utils/serialize.js'

describe('serializeBigInt', () => {
  it('converts top-level bigint to a decimal string', () => {
    expect(serializeBigInt(1073741824n)).toBe('1073741824')
  })

  it('round-trips bigint fields nested in objects and arrays', () => {
    const payload = {
      id: 'file-1',
      sizeBytes: 12345678901234567890n,
      files: [{ sizeBytes: 0n }, { sizeBytes: -42n }],
      quota: { totalBytes: null, usedBytes: 5n },
    }

    const serialized = serializeBigInt(payload) as typeof payload

    expect(serialized.sizeBytes).toBe('12345678901234567890')
    expect(serialized.files[0].sizeBytes).toBe('0')
    expect(serialized.files[1].sizeBytes).toBe('-42')
    expect(serialized.quota.usedBytes).toBe('5')

    const json = JSON.parse(JSON.stringify(serializeBigInt(payload)))
    expect(json.sizeBytes).toBe('12345678901234567890')
    expect(json.files[1].sizeBytes).toBe('-42')
    expect(json.quota.totalBytes).toBeNull()
  })

  it('preserves strings, numbers, booleans, null and Date values', () => {
    const date = new Date('2026-01-02T03:04:05.000Z')
    const result = serializeBigInt({ name: 'a', count: 3, active: true, missing: null, createdAt: date }) as Record<string, unknown>
    expect(result.name).toBe('a')
    expect(result.count).toBe(3)
    expect(result.active).toBe(true)
    expect(result.missing).toBeNull()
    expect(result.createdAt).toBe(date)
  })

  it('handles circular references without throwing', () => {
    const value: Record<string, unknown> = { id: 1n }
    value.self = value
    const result = serializeBigInt(value) as Record<string, unknown>
    expect(result.id).toBe('1')
    expect(result.self).toBe('[Circular]')
  })
})

describe('jsonSafe', () => {
  it('returns a value that JSON.stringify can consume', () => {
    const value = { sizeBytes: 99n, nested: [1n, 2n] }
    const safe = jsonSafe(value) as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(safe))).toEqual({ sizeBytes: '99', nested: ['1', '2'] })
  })

  it('returns null for undefined and null input', () => {
    expect(jsonSafe(undefined)).toBeNull()
    expect(jsonSafe(null)).toBeNull()
  })

  it('drops functions and converts NaN to null', () => {
    const safe = jsonSafe({ fn: () => 1, bad: NaN }) as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(safe))).toEqual({ bad: null })
  })
})
