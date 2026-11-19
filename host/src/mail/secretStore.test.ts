import { describe, it, expect } from 'vitest'
import { createKeychainStore, KEYCHAIN_SERVICE, runProcess, type ProcessRun } from './secretStore.js'

/**
 * The Keychain secret store (spec #66), by the research document's answer 9:
 * `security -i` takes every write and delete on its standard input, so no
 * secret is ever in a process argument list. The process runner is injected:
 * no test here touches the real Keychain.
 */

interface Call { command: string; args: string[]; stdin: string | undefined }

function recorder(answer: (c: Call) => { code: number; stdout?: string } = () => ({ code: 0 })): { calls: Call[]; run: ProcessRun } {
  const calls: Call[] = []
  return {
    calls,
    run: async (command, args, stdin) => {
      const call = { command, args: [...args], stdin }
      calls.push(call)
      const out = answer(call)
      return { code: out.code, stdout: out.stdout ?? '', stderr: '' }
    },
  }
}

// Spaces, double quotes and a backslash: the characters answer 9 checked.
const SECRET = 'REFRESH "TOKEN" \\PLACEHOLDER'

describe('the Keychain secret store', () => {
  it('writes a secret through `security -i` on standard input, never in the argument list', async () => {
    const io = recorder()
    await createKeychainStore(io.run).set('gmail:ada@example.com:refresh_token', SECRET)
    expect(io.calls).toHaveLength(1)
    const [call] = io.calls
    expect(call!.command).toBe('security')
    expect(call!.args).toEqual(['-i'])
    for (const arg of call!.args) expect(arg).not.toContain('PLACEHOLDER')
    expect(call!.stdin).toBe(
      `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "gmail:ada@example.com:refresh_token" -w "REFRESH \\"TOKEN\\" \\\\PLACEHOLDER"\n`,
    )
  })

  it('stores under the tool\'s own service name', () => {
    expect(KEYCHAIN_SERVICE).toBe('job-form-filler')
  })

  it('reads a secret back from standard output without the trailing newline', async () => {
    const io = recorder(() => ({ code: 0, stdout: `${SECRET}\n` }))
    expect(await createKeychainStore(io.run).get('gmail:ada@example.com:client_secret')).toBe(SECRET)
    expect(io.calls[0]!.args).toEqual(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'gmail:ada@example.com:client_secret', '-w'])
  })

  it('reads no item as null', async () => {
    const io = recorder(() => ({ code: 44 }))
    expect(await createKeychainStore(io.run).get('gmail:ada@example.com:client_secret')).toBeNull()
  })

  it('deletes through `security -i`, and a missing item is not an error', async () => {
    const io = recorder(() => ({ code: 44 }))
    await createKeychainStore(io.run).delete('gmail:ada@example.com:client_secret')
    expect(io.calls[0]!.args).toEqual(['-i'])
    expect(io.calls[0]!.stdin).toBe(`delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "gmail:ada@example.com:client_secret"\n`)
  })

  it('fails a write the Keychain refused, without naming the secret', async () => {
    const io = recorder(() => ({ code: 1 }))
    const error = await createKeychainStore(io.run).set('a', SECRET).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('PLACEHOLDER')
  })

  it('refuses a secret with a line break, which would end the command early', async () => {
    const io = recorder()
    await expect(createKeychainStore(io.run).set('a', 'one\nadd-generic-password -s x')).rejects.toThrow(/line break/)
    expect(io.calls).toEqual([])
  })
})

describe('the process runner', () => {
  it('hands standard input to the process and returns its output and exit code', async () => {
    const out = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'from stdin')
    expect(out).toEqual({ code: 0, stdout: 'from stdin', stderr: '' })
  })
})
