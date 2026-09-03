import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './log.js'
import { LLM_TASKS, type LlmTask, type ModelOverrides } from './llm/models.js'

export interface HostConfig {
  claudePath: string
  /** B2d: the codex CLI used for the generation review pass. */
  codexPath: string
  /** B2c: absolute paths to local project notes read into the generation
   *  prompt (capped; missing/unreadable paths skipped silently). */
  projectsPaths: string[]
  dbPath: string
  authCachePath: string
  /** Per-task model id overrides; unknown keys and non-string values are
   *  dropped with a warning. Empty means "use the defaults". */
  models: ModelOverrides
}

// JFF_HOME lets the e2e harness point a host process at a throwaway directory.
export const HOME_DIR = process.env.JFF_HOME ?? join(homedir(), '.job-form-filler')

/** Keeps only known task keys with non-empty string ids, warning once per
 *  dropped key. A missing or malformed `models` yields {}. */
function readModels(raw: unknown): ModelOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const known = new Set<string>(LLM_TASKS)
  const out: ModelOverrides = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) {
      log('warn', 'config.models: unknown task key ignored', { key })
      continue
    }
    if (typeof value !== 'string' || value === '') {
      log('warn', 'config.models: model id must be a non-empty string', { key })
      continue
    }
    out[key as LlmTask] = value
  }
  return out
}

export function loadConfig(): HostConfig {
  const defaults: HostConfig = {
    claudePath: 'claude',
    codexPath: 'codex',
    projectsPaths: [],
    dbPath: join(HOME_DIR, 'db.sqlite'),
    authCachePath: join(HOME_DIR, 'authcheck.json'),
    models: {},
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
      models: readModels(cfg?.models),
    }
  } catch {
    return defaults
  }
}
