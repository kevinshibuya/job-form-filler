import { spawn } from 'node:child_process'

/**
 * Where the Mail account's secrets live: the refresh token and the client
 * secret (spec #66). Never the database, the config file, the log or a
 * response to the extension.
 */
export interface SecretStore {
  /** Writes or replaces the secret under this account name. */
  set(account: string, secret: string): Promise<void>
  /** The secret under this account name, or null when there is none. */
  get(account: string): Promise<string | null>
  /** Removes the secret; one that is not there is not an error. */
  delete(account: string): Promise<void>
}

/** The Keychain's service name for every item the tool keeps. */
export const KEYCHAIN_SERVICE = 'job-form-filler'

/** The Keychain account name of one of a Mail account's secrets. */
export const secretAccount = (kind: string, address: string, secret: 'refresh_token' | 'client_secret'): string =>
  `${kind}:${address}:${secret}`

/** Runs a process with these arguments and this standard input. */
export type ProcessRun = (command: string, args: readonly string[], stdin?: string) =>
  Promise<{ code: number; stdout: string; stderr: string }>

export const runProcess: ProcessRun = (command, args, stdin) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  child.stdin.end(stdin ?? '')
})

/** `security -i`'s quoting: the text in double quotes, with each `"` and `\` escaped. */
const quote = (text: string): string => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`

/** `security`'s exit code for an item that is not there. */
const NOT_FOUND = 44

/**
 * The macOS Keychain, through the `security` tool, by the research document's
 * answer 9. A write or a delete runs `security -i` and passes the command on
 * standard input, so the argument list is only `-i` and `ps` never shows a
 * secret. A read gets the secret back on standard output. `run` is the one
 * process call; a test passes its own.
 */
export function createKeychainStore(run: ProcessRun = runProcess): SecretStore {
  const interactive = async (command: string, ok: readonly number[], what: string): Promise<void> => {
    const out = await run('security', ['-i'], `${command}\n`)
    // The error names the action and the code, never the command: it holds the secret.
    if (!ok.includes(out.code)) throw new Error(`the Keychain refused to ${what} (security exited ${out.code})`)
  }
  return {
    async set(account, secret) {
      if (/[\r\n]/.test(secret) || /[\r\n]/.test(account)) throw new Error('a Keychain secret cannot hold a line break')
      await interactive(
        `add-generic-password -U -s ${quote(KEYCHAIN_SERVICE)} -a ${quote(account)} -w ${quote(secret)}`, [0], `store ${account}`,
      )
    },
    async get(account) {
      const out = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])
      if (out.code === NOT_FOUND) return null
      if (out.code !== 0) throw new Error(`the Keychain refused to read ${account} (security exited ${out.code})`)
      return out.stdout.replace(/\n$/, '')
    },
    async delete(account) {
      if (/[\r\n]/.test(account)) throw new Error('a Keychain account name cannot hold a line break')
      await interactive(`delete-generic-password -s ${quote(KEYCHAIN_SERVICE)} -a ${quote(account)}`, [0, NOT_FOUND], `delete ${account}`)
    },
  }
}
