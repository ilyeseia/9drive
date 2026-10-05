import { describe, expect, it } from 'vitest'
import { loginSchema, registerSchema } from '../../modules/auth/auth.routes.js'

describe('email normalization (auth schemas)', () => {
  it('trims and lowercases email on register', () => {
    const parsed = registerSchema.parse({
      name: 'Ada Lovelace',
      email: '  Ada.Lovelace@Example.COM ',
      password: 'password123',
    })
    expect(parsed.email).toBe('ada.lovelace@example.com')
  })

  it('trims and lowercases email on login', () => {
    const parsed = loginSchema.parse({ email: ' USER@Domain.Org ', password: 'secret' })
    expect(parsed.email).toBe('user@domain.org')
  })

  it('produces the same normalized email for mixed-case variants', () => {
    const a = loginSchema.parse({ email: 'First.Last@Mail.COM', password: 'secret' })
    const b = loginSchema.parse({ email: 'first.last@mail.com', password: 'secret' })
    expect(a.email).toBe(b.email)
  })

  it('still rejects malformed emails after normalization', () => {
    expect(() => loginSchema.parse({ email: 'not-an-email', password: 'secret' })).toThrow()
    expect(() => registerSchema.parse({ name: 'Ada', email: 'a@b', password: 'password123' })).toThrow()
  })
})
