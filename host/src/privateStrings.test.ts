import { describe, expect, it } from 'vitest'
import { redactPrivate, scanLine } from '@jff/shared/privateStrings'
// @ts-expect-error -- the guard is a plain script with no types; this test only compares answers.
import { scanLine as guardScanLine } from '../../scripts/check-private.mjs'

// The Native host's package calls the same private-strings rules the guard
// runs, so a Capture is refused on exactly what a commit would be refused on.
// Every offending sample is assembled at run time, so this file never holds a
// string the guard would refuse to commit.
const denylist = ['lovelace street']
const privateString = 'I live on Lovelace Street, number 12'
const realEmail = ['jane.doe', 'realcorp.io'].join('@')
const credential = `ghp_${'a1B2'.repeat(6)}`
const allowed = 'write to ada@example.com or call +1 555 0100'

describe('the private-strings rules in the Native host package', () => {
  it.each([
    ['a private string', privateString, 'private-string'],
    ['a real e-mail address', `mail ${realEmail}`, 'email'],
    ['a credential-shaped string', `TOKEN=${credential}`, 'credential'],
  ])('flag %s as the guard does', (_, line, rule) => {
    const found = scanLine(line, denylist)
    expect(found.map((hit) => hit.rule)).toEqual([rule])
    expect(found).toEqual(guardScanLine(line, denylist))
  })

  it('pass an allowed sample as the guard does', () => {
    expect(scanLine(allowed, denylist)).toEqual([])
    expect(guardScanLine(allowed, denylist)).toEqual([])
  })

  it('replace what they flag, and leave the allowed sample alone', () => {
    const text = [privateString, realEmail, credential, allowed].join('\n')
    const clean = redactPrivate(text, denylist)
    expect(clean).toBe(['I live on redacted, number 12', 'someone@example.com', 'REDACTED-KEY', allowed].join('\n'))
    expect(clean.split('\n').flatMap((line) => guardScanLine(line, denylist))).toEqual([])
  })
})
