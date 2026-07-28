import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface HostConfig {
  claudePath: string
  dbPath: string
  authCachePath: string
}

export const HOME_DIR = join(homedir(), '.job-form-filler')

export function loadConfig(): HostConfig {
  const defaults: HostConfig = {
    claudePath: 'claude',
    dbPath: join(HOME_DIR, 'db.sqlite'),
    authCachePath: join(HOME_DIR, 'authcheck.json'),
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(join(HOME_DIR, 'config.json'), 'utf8'))
    const cfg = raw as Partial<HostConfig> | null
    return {
      claudePath: typeof cfg?.claudePath === 'string' ? cfg.claudePath : defaults.claudePath,
      dbPath: typeof cfg?.dbPath === 'string' ? cfg.dbPath : defaults.dbPath,
      authCachePath: defaults.authCachePath,
    }
  } catch {
    return defaults
  }
}
