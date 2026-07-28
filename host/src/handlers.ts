import type Database from 'better-sqlite3'
import {
  isFieldKey, isProfileKey,
  type HostErrorKind, type HostRequest, type HostResponse, type SelfCheck,
} from '@jff/shared'
import { paginate } from './chunk.js'
import type { HostConfig } from './config.js'
import {
  getAnswerBank, getCachedResponse, getProfile, getSelector, insertApplication,
  listAllAnswers, listReferenceAnswers, putCachedResponse, saveLearnedMapping,
  saveSelector, setAnswerBank, setProfile, upsertAnswer,
} from './db/repos.js'
import { ClaudeError, type ClaudeRunner } from './llm/claudeCli.js'
import { buildProfileSummary, runGeneration } from './llm/generate.js'
import { detectLanguage, normalizeQuestion } from './resolve/normalize.js'
import { resolveFields } from './resolve/waterfall.js'
import { log } from './log.js'

export interface HandlerDeps {
  db: Database.Database
  runner: ClaudeRunner
  config: HostConfig
  selfCheckFn: () => Promise<SelfCheck>
}

const ok = (requestId: string, result: unknown): HostResponse => ({ requestId, ok: true, result })
const fail = (requestId: string, kind: HostErrorKind, message: string): HostResponse =>
  ({ requestId, ok: false, error: { kind, message } })

export async function handleRequest(deps: HandlerDeps, req: HostRequest): Promise<HostResponse> {
  // Idempotency: a repeated requestId replays the stored SUCCESS verbatim so a
  // dropped connection re-fetches rather than re-running a paid claude call.
  const cached = safe(() => getCachedResponse(deps.db, req.requestId))
  if (cached.ok && cached.value !== null) {
    try { return JSON.parse(cached.value) as HostResponse } catch { /* fall through and recompute */ }
  }

  const response = await compute(deps, req)
  if (response.ok) {
    const stored = safe(() => putCachedResponse(deps.db, req.requestId, JSON.stringify(response)))
    if (!stored.ok) log('warn', 'could not cache response', { requestId: req.requestId })
  }
  return response
}

function safe<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try { return { ok: true, value: fn() } } catch (error) { return { ok: false, error } }
}

async function compute(deps: HandlerDeps, req: HostRequest): Promise<HostResponse> {
  const { db } = deps
  try {
    switch (req.method) {
      case 'selfCheck':
        return ok(req.requestId, await deps.selfCheckFn())

      case 'profile.get':
        return ok(req.requestId, getProfile(db))

      case 'profile.set': {
        const bad = Object.keys(req.params.values).filter((k) => !isProfileKey(k))
        if (bad.length > 0) return fail(req.requestId, 'bad_request', `unknown profile keys: ${bad.join(', ')}`)
        setProfile(db, req.params.values)
        return ok(req.requestId, getProfile(db))
      }

      case 'answerBank.get':
        return ok(req.requestId, getAnswerBank(db))

      case 'answerBank.set': {
        const bad = Object.keys(req.params.values).filter((k) => !isFieldKey(k) || isProfileKey(k))
        if (bad.length > 0) return fail(req.requestId, 'bad_request', `unknown answer-bank keys: ${bad.join(', ')}`)
        setAnswerBank(db, req.params.values)
        return ok(req.requestId, getAnswerBank(db))
      }

      case 'resolve':
        return ok(req.requestId, await resolveFields({ db, runner: deps.runner }, req.params))

      case 'generate': {
        const lang = detectLanguage(req.params.questionRaw)
        const references = listReferenceAnswers(db, normalizeQuestion(req.params.questionRaw), lang).map((r) => r.answer)
        const draft = await runGeneration(deps.runner, {
          question: req.params.questionRaw,
          jobText: req.params.jobText,
          company: req.params.company,
          profileSummary: buildProfileSummary(getProfile(db), getAnswerBank(db)),
          references,
        })
        return ok(req.requestId, { draft })
      }

      case 'save': {
        let filled = 0
        const tx = db.transaction(() => {
          for (const item of req.params.items) {
            if (item.answer.trim() === '') continue
            if (item.fieldKey !== null) {
              // A factual key: update the owning store instead of qa_memory.
              if (isProfileKey(item.fieldKey)) setProfile(db, { [item.fieldKey]: item.answer })
              else setAnswerBank(db, { [item.fieldKey]: item.answer })
            } else {
              upsertAnswer(db, {
                questionNormalized: normalizeQuestion(item.questionRaw),
                questionRaw: item.questionRaw,
                answer: item.answer,
                language: detectLanguage(item.questionRaw),
                reusability: item.reusability,
                sourceUrl: req.params.url,
              })
            }
            filled++
          }
          insertApplication(db, {
            url: req.params.url, company: req.params.company,
            filledCount: filled, generatedCount: req.params.generatedCount,
          })
        })
        tx()
        return ok(req.requestId, { saved: filled })
      }

      case 'selector.get':
        return ok(req.requestId, { selector: getSelector(db, req.params.hostname, req.params.purpose) })

      case 'selector.save':
        saveSelector(db, req.params.hostname, req.params.purpose, req.params.selector)
        return ok(req.requestId, { selector: req.params.selector })

      case 'mapping.confirm':
        saveLearnedMapping(db, normalizeQuestion(req.params.label), req.params.fieldKey)
        return ok(req.requestId, { label: normalizeQuestion(req.params.label), fieldKey: req.params.fieldKey })

      case 'qa.list':
        // No panel consumer in v1 (deliberate): this method is the executable
        // proof of the {page, done} chunking protocol. See Task 11 preamble.
        return ok(req.requestId, paginate(listAllAnswers(db), req.params.page))
    }
    // Exhaustiveness proof: HostRequestSchema already rejected anything else.
    const never: never = req
    return fail((never as HostRequest).requestId, 'bad_request', 'unknown method')
  } catch (e) {
    if (e instanceof ClaudeError) return fail(req.requestId, e.kind, e.message)
    const message = e instanceof Error ? e.message : String(e)
    log('error', 'handler failed', { method: req.method, message })
    return fail(req.requestId, 'db', message)
  }
}
