import { describe, expect, it } from 'vitest'
import { addedLines, scanIdentity, scanLine } from './check-private.mjs'

// Every offending sample is assembled at run time, so this file never holds a
// string the guard it tests would refuse to commit.
const realEmail = ['jane.doe', 'realcorp.io'].join('@')
const homeDir = ['', 'Users', 'janedoe'].join('/')
const homePath = `${homeDir}/notes.md`
const token = `ghp_${'a1B2'.repeat(6)}`

describe('scanLine', () => {
  it('passes the test persona and placeholder paths', () => {
    expect(scanLine("email: 'ada@example.com', alt: 'k@x.dev', work: 'ada@work.example.com'")).toEqual([])
    expect(scanLine("nativeManifestPath('/Users/k'), '/Users/x/.nvm/bin', '/home/runner/work'")).toEqual([])
    expect(scanLine('npm i react@18.3.1 @jff/shared, see icon@2x.png')).toEqual([])
  })

  it('flags an address on a real domain', () => {
    expect(scanLine(`contact ${realEmail} today`)).toEqual([{ rule: 'email', detail: realEmail }])
  })

  it('flags a home-directory path that names an account', () => {
    expect(scanLine(`cp ${homePath} .`)).toEqual([{ rule: 'home-path', detail: homeDir }])
  })

  it('flags a credential without echoing it whole', () => {
    const [hit] = scanLine(`GITHUB_TOKEN=${token}`)
    expect(hit.rule).toBe('credential')
    expect(hit.detail).not.toContain(token)
  })

  it('flags a denylist string in any case, naming the entry and never the string', () => {
    const hits = scanLine('Lives in SPRINGFIELD Heights', ['springfield heights'])
    expect(hits).toEqual([{ rule: 'private-string', detail: 'denylist entry 1' }])
  })

  // Google's secrets, as a Desktop client's sign-in hands them out (spec #66, ticket #67).
  const google = {
    'access token': ['ya29', `a0AfB_${'byXk3mQ9'.repeat(8)}`].join('.'),
    'refresh token': ['1', '', `0gKz7${'Xb4_Tq-9'.repeat(5)}`].join('/'),
    'refresh token in a form body': ['1', '', `0gKz7${'Xb4_Tq-9'.repeat(5)}`].join('%2F'),
    'client secret': ['GOCSPX', `Ab3dE${'fG7hJ'.repeat(5)}x`].join('-'),
    'client id': `${'1234567'.repeat(2)}-${'a1b2c3d4'.repeat(4)}.${['apps', 'googleusercontent', 'com'].join('.')}`,
  }

  for (const [shape, secret] of Object.entries(google)) {
    it(`flags a Google ${shape} without echoing it whole`, () => {
      const hits = scanLine(`{"value": "${secret}"}`)
      expect(hits.map((hit) => hit.rule)).toEqual(['credential'])
      expect(hits[0].detail).not.toContain(secret)
    })
  }

  it('passes the placeholders the recorded Gmail transcripts carry', () => {
    const placeholders = [
      '"access_token": "ACCESS_TOKEN_PLACEHOLDER"',
      '"refresh_token": "REFRESH_TOKEN_PLACEHOLDER"',
      'client_id=CLIENT_ID_PLACEHOLDER.apps.googleusercontent.com&client_secret=CLIENT_SECRET_PLACEHOLDER',
      '"id": "MESSAGE_ID_PLACEHOLDER", "threadId": "THREAD_ID_PLACEHOLDER"',
      'redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2F, see https://oauth2.googleapis.com/token',
    ]
    for (const line of placeholders) expect(scanLine(line)).toEqual([])
  })

  it('allows the third-party strings the captured fixtures carry, even glued to escaped markup', () => {
    expect(scanLine('"\\u003enoreply@github.com\\u003c"')).toEqual([])
  })
})

describe('scanIdentity', () => {
  it('accepts only GitHub noreply addresses', () => {
    expect(scanIdentity('123+someone@users.noreply.github.com')).toEqual([])
    expect(scanIdentity('noreply@github.com')).toEqual([])
    expect(scanIdentity(realEmail)).toEqual([{ rule: 'identity', detail: realEmail }])
  })
})

describe('addedLines', () => {
  it('reads added lines with their file and line number, and skips removals', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -3,0 +4,2 @@ context',
      '+first',
      '+second',
      '@@ -9 +11 @@',
      '-gone',
      '+third',
      'diff --git a/old.ts b/old.ts',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-removed',
    ].join('\n')
    expect(addedLines(diff)).toEqual([
      { file: 'a.ts', line: 4, text: 'first' },
      { file: 'a.ts', line: 5, text: 'second' },
      { file: 'a.ts', line: 11, text: 'third' },
    ])
  })
})
