import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface HostConfig {
  claudePath: string
  /** B2d: the codex CLI used for the generation review pass. */
  codexPath: string
  /** B2c: absolute paths to local project notes read into the generation
   *  prompt (capped; missing/unreadable paths skipped silently). */
  projectsPaths: string[]
  dbPath: string
  authCachePath: string
}

// JFF_HOME lets the e2e harness point a host process at a throwaway directory.
export const HOME_DIR = process.env.JFF_HOME ?? join(homedir(), '.job-form-filler')

export function loadConfig(): HostConfig {
  const defaults: HostConfig = {
    claudePath: 'claude',
    codexPath: 'codex',
    projectsPaths: [],
    dbPath: join(HOME_DIR, 'db.sqlite'),
    authCachePath: join(HOME_DIR, 'authcheck.json'),
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(join(HOME_DIR, 'config.json'), 'utf8'))
    const cfg = raw as Partial<HostConfig> | null
    return {
      claudePath: typeof cfg?.claudePath === 'string' ? cfg.claudePath : defaults.claudePath,
      codexPath: typeof cfg?.codexPath === 'string' ? cfg.codexPath : defaults.codexPath,
      projectsPaths: Array.isArray(cfg?.projectsPaths)
        ? cfg.projectsPaths.filter((p): p is string => typeof p === 'string')
        : defaults.projectsPaths,
      dbPath: typeof cfg?.dbPath === 'string' ? cfg.dbPath : defaults.dbPath,
      authCachePath: defaults.authCachePath,
    }
  } catch {
    return defaults
  }
}
