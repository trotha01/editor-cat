import { afterEach, describe, expect, it } from 'vitest'
import { hasAllowlist, isAllowedEmail, refusalDetail } from './allowlist'

/**
 * Who gets in. Every generation on this site is billed to whoever deployed it,
 * so this list is the whole of the answer to "and who may spend that" — which
 * makes each of these cases worth pinning rather than inferring from a proxy.
 */

const saved = process.env.ALLOWED_EMAILS

afterEach(() => {
  if (saved === undefined) delete process.env.ALLOWED_EMAILS
  else process.env.ALLOWED_EMAILS = saved
})

const withList = (value: string) => {
  process.env.ALLOWED_EMAILS = value
}

describe('isAllowedEmail', () => {
  it('lets a listed address in', () => {
    withList('trotha01@gmail.com, someone@else.test')
    expect(isAllowedEmail('trotha01@gmail.com')).toBe(true)
    expect(isAllowedEmail('someone@else.test')).toBe(true)
  })

  it('ignores case and the whitespace a pasted list always has', () => {
    withList('  Trotha01@Gmail.com ,\n  second@example.com  ')
    expect(isAllowedEmail('TROTHA01@gmail.com')).toBe(true)
    expect(isAllowedEmail(' second@example.com ')).toBe(true)
  })

  it('keeps everybody else out', () => {
    withList('trotha01@gmail.com')
    expect(isAllowedEmail('someone@gmail.com')).toBe(false)
    // Neither a prefix nor a suffix of a listed address counts as one.
    expect(isAllowedEmail('trotha01@gmail.com.attacker.test')).toBe(false)
    expect(isAllowedEmail('nottrotha01@gmail.com')).toBe(false)
  })

  it('takes a whole domain when the entry starts with @', () => {
    withList('@example.com')
    expect(isAllowedEmail('anyone@example.com')).toBe(true)
    expect(isAllowedEmail('anyone@notexample.com')).toBe(false)
    // The domain has to be the whole of it, not merely the end of it.
    expect(isAllowedEmail('anyone@sub.example.com')).toBe(false)
  })

  it('refuses a session with no address rather than trusting it', () => {
    // A tenant that does not put an email claim in its tokens cannot be checked
    // against a list of emails, and "cannot be checked" is not "is allowed".
    withList('@example.com')
    expect(isAllowedEmail(null)).toBe(false)
    expect(isAllowedEmail('')).toBe(false)
    expect(isAllowedEmail('not-an-address')).toBe(false)
  })

  it('refuses everybody when nobody has been listed', () => {
    // The deliberate default. A deployment whose owner has not said who it is
    // for is closed, not open: an open one looks identical to a working one
    // until the bill arrives, and this looks broken immediately to exactly the
    // person who can fix it.
    delete process.env.ALLOWED_EMAILS
    expect(hasAllowlist()).toBe(false)
    expect(isAllowedEmail('anyone@example.com')).toBe(false)

    withList('   ,  \n ')
    expect(hasAllowlist()).toBe(false)
    expect(isAllowedEmail('anyone@example.com')).toBe(false)
  })

  it('does not treat a bare @ as a wildcard', () => {
    // Somebody will try it. It is a typo, not a policy.
    withList('@')
    expect(isAllowedEmail('anyone@anywhere.test')).toBe(false)
  })
})

describe('refusalDetail', () => {
  it('names the missing variable when nobody is listed', () => {
    delete process.env.ALLOWED_EMAILS
    expect(refusalDetail('someone@example.com')).toContain('ALLOWED_EMAILS')
  })

  it('blames the tenant, not the person, when the token carries no address', () => {
    withList('@example.com')
    expect(refusalDetail(null)).toMatch(/email claim/)
  })

  it('says which address was refused, so the right one can be asked for', () => {
    withList('@example.com')
    expect(refusalDetail('someone@other.test')).toContain('someone@other.test')
  })
})
