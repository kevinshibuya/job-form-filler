import type Database from 'better-sqlite3'
import {
  FACT_MAX_CHARS, HostRequestSchema, isFieldKey, isProfileKey, normalizeFactValue, toStoredText,
  type FieldKey, type HostErrorKind, type HostRequest, type HostResponse, type ResolveParams, type SelfCheck,
} from '@jff/shared'
import { saveCapture } from './capture.js'
import { paginate } from './chunk.js'
import type { HostConfig } from './config.js'
import {
  checkApplied, checkAppliedByAddress, getAnswerBank, getAppliedTexts, getCachedResponse, getProfile, getSelector, clearSelector,
  insertApplication, listAllAnswers, listApplied, listReferenceAnswers,
  markApplied, putCachedResponse, saveLearnedMapping, saveSelector, setAnswerBank,
  setProfile, upsertAnswer,
} from './db/repos.js'
import { ClaudeError, type ClaudeRunner } from './llm/claudeCli.js'
import { CodexError, type CodexRunner } from './llm/codexCli.js'
import { buildProfileSummary, runGeneration, sanitizeDraft, type FormAnswerInput } from './llm/generate.js'
import { readProjectNotes } from './llm/projects.js'
import { reviewDraft } from './llm/reviewDraft.js'
import { claimsInDraft } from './llm/draftCheck.js'
import { runFactsExtract } from './llm/factsExtract.js'
import { runOptionPick } from './llm/optionPick.js'
import { runApplyAddressPick } from './llm/applyAddressPick.js'
import { draftApplicationEmail } from './llm/applicationEmail.js'
import { postingLanguage } from './postingLanguage.js'
import { learnWording } from './resolve/learnedWordings.js'
import { detectLanguage, normalizeQuestion } from './resolve/normalize.js'
import { resolveFirst, resolveMapping, type WaterfallDeps } from './resolve/waterfall.js'
import { log } from './log.js'
import type { ResolvedModels } from './llm/models.js'
import { asMailError } from './mail/account.js'
import type { MailRequests } from './mail/requests.js'


// A fact is one line. Normalise every incoming value, then refuse anything still
// over the cap rather than truncating: a value that long is prose that took a
// wrong turn, and silently storing half of it is worse than saying no.
// A key with a typed form stores its canonical text or is refused
// (shared/src/typedValues.ts). Callers have already checked every key is a
// Known key. Returns the cleaned map, or the error message for the first refusal.
function shapeFactValues(values: Record<string, string>): Record<string, string> | string {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values)) {
    const n = normalizeFactValue(v)
    if (n.length > FACT_MAX_CHARS) return `fact value over ${FACT_MAX_CHARS} characters: ${k}`
    const stored = toStoredText(k as FieldKey, n)
    if (!stored.ok) return stored.reason
    out[k] = stored.text
  }
  return out
}

export interface HandlerDeps {
  db: Database.Database
  runner: ClaudeRunner
  /** B2d: the codex reviewer. Failures degrade; it never blocks generation. */
  codex: CodexRunner
  config: HostConfig
  /** Resolved per-task model ids; every LLM call names one. */
  models: ResolvedModels
  selfCheckFn: () => Promise<SelfCheck>
  /** Set when the database was refused (a newer version of the tool wrote it):
   *  every request but the Self-check answers this reason and touches nothing,
   *  and `db` is a read-only handle. */
  dbRefusal?: string
  /** The Mail account requests. A host built without them refuses `mail.` requests. */
  mail?: MailRequests
}

/** No request whose method starts with this is ever replayed from the request
 *  log (spec #66): each one acts on the Mail account or reads its state now. */
const NEVER_REPLAYED = 'mail.'

const waterfallDeps = (deps: HandlerDeps): WaterfallDeps =>
  ({ db: deps.db, codex: deps.codex, mappingOpts: { model: deps.models.mapping, timeoutMs: 240_000 } })

const ok = (requestId: string, result: unknown): HostResponse => ({ requestId, ok: true, result })
const fail = (requestId: string, kind: HostErrorKind, message: string): HostResponse =>
  ({ requestId, ok: false, error: { kind, message } })

export async function handleRequest(deps: HandlerDeps, req: HostRequest): Promise<HostResponse> {
  // Before the replay lookup: a refused database is not read either.
  if (deps.dbRefusal !== undefined && req.method !== 'selfCheck') return fail(req.requestId, 'db', deps.dbRefusal)

  if (req.method.startsWith(NEVER_REPLAYED)) return compute(deps, req)

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

/** A request as it arrives on stdin: parsed against the schema, refused as a
 *  bad_request when it does not fit, handled when it does. */
export async function handleRaw(deps: HandlerDeps, raw: unknown): Promise<HostResponse> {
  const parsed = HostRequestSchema.safeParse(raw)
  if (parsed.success) return handleRequest(deps, parsed.data)
  const requestId = typeof (raw as { requestId?: unknown })?.requestId === 'string'
    ? (raw as { requestId: string }).requestId : 'unknown'
  return fail(requestId, 'bad_request', parsed.error.message)
}

/** One log line per Resolution request, naming the Scan's ATS (spec #41) so a
 *  log reads without the page. The ATS is logged and nothing branches on it:
 *  every ATS gets the same answer. A request with none is generic. */
function logResolution(method: 'resolve.first' | 'resolve.mapping', params: ResolveParams): void {
  log('info', method, { ats: params.ats ?? 'generic', epoch: params.epoch, fields: params.fields.length })
}

const noMail = (requestId: string): HostResponse => fail(requestId, 'process', 'this Native host has no Mail account driver')

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
        const shaped = shapeFactValues(req.params.values)
        if (typeof shaped === 'string') return fail(req.requestId, 'bad_request', shaped)
        setProfile(db, shaped)
        return ok(req.requestId, getProfile(db))
      }

      case 'answerBank.get':
        return ok(req.requestId, getAnswerBank(db))

      case 'answerBank.set': {
        const bad = Object.keys(req.params.values).filter((k) => !isFieldKey(k) || isProfileKey(k))
        if (bad.length > 0) return fail(req.requestId, 'bad_request', `unknown answer-bank keys: ${bad.join(', ')}`)
        const shaped = shapeFactValues(req.params.values)
        if (typeof shaped === 'string') return fail(req.requestId, 'bad_request', shaped)
        setAnswerBank(db, shaped)
        return ok(req.requestId, getAnswerBank(db))
      }

      // No model: the host never hands this step a runner.
      case 'resolve.first':
        logResolution(req.method, req.params)
        return ok(req.requestId, resolveFirst(db, req.params))

      case 'resolve.mapping':
        logResolution(req.method, req.params)
        return ok(req.requestId, await resolveMapping(waterfallDeps(deps), req.params))

      case 'generate': {
        const lang = detectLanguage(req.params.questionRaw)
        const references = listReferenceAnswers(db, normalizeQuestion(req.params.questionRaw), lang).map((r) => r.answer)
        const input: FormAnswerInput = {
          question: req.params.questionRaw,
          description: req.params.description ?? null,
          jobText: req.params.jobText,
          company: req.params.company,
          profileSummary: buildProfileSummary(getProfile(db), getAnswerBank(db)),
          cvText: req.params.cvText ?? null,
          projectNotes: readProjectNotes(deps.config.projectsPaths),
          references,
          fieldClass: req.params.fieldClass ?? 'personal_fact',
        }
        // The reply names the model that wrote the Draft, so the Side panel
        // can keep it beside the text (spec #66).
        const model = deps.models.generate
        const draft = await runGeneration(deps.runner, input, { model })
        // B2d: claude draft → Draft check (codex) → final. ANY Draft check
        // failure degrades to the unchecked draft — codex never blocks
        // generation. A flagged sentence reaches the reply only when the final
        // Draft contains it (ADR 0004: the Draft is still shown, with the warning).
        let reply: { draft: string; model: string; unsupportedClaims?: string[] } = { draft, model }
        try {
          const checked = await reviewDraft(deps.codex, input, draft, { model: deps.models.reviewDraft, retryTransient: false })
          const final = sanitizeDraft(checked.draft)
          const unsupportedClaims = claimsInDraft(final, checked.unsupported)
          reply = unsupportedClaims.length === 0 ? { draft: final, model } : { draft: final, model, unsupportedClaims }
        } catch (e) {
          const kind = e instanceof CodexError || e instanceof ClaudeError ? e.kind : 'process'
          log('warn', 'Draft check failed; returning unreviewed draft', {
            kind, message: e instanceof Error ? e.message : String(e),
          })
        }
        return ok(req.requestId, reply)
      }

      case 'save': {
        let filled = 0
        const tx = db.transaction(() => {
          for (const item of req.params.items) {
            if (item.answer.trim() === '') continue
            // Every item here is keyless: SaveItemSchema pins fieldKey to null,
            // so a save can only ever reach qa_memory. Facts go through
            // profile.set / answerBank.set instead.
            upsertAnswer(db, {
              questionNormalized: normalizeQuestion(item.questionRaw),
              questionRaw: item.questionRaw,
              answer: item.answer,
              language: detectLanguage(item.questionRaw),
              reusability: item.reusability,
              sourceUrl: req.params.url,
            })
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

      // The model pick (ADR 0008). Only what the request carries reaches the
      // prompt: the host reads nothing from the Profile for it.
      case 'option.pick': {
        const { label, value, options } = req.params
        const position = await runOptionPick(deps.codex, { label, value, options }, { model: deps.models.optionPick, timeoutMs: 120_000 })
        return ok(req.requestId, { position })
      }

      // The Apply address pick (spec #66, ADR 0008). Only what the request
      // carries reaches the prompt, all of it page content. The reply is a
      // position inside the list or none: never an address.
      case 'applyAddress.pick': {
        const position = await runApplyAddressPick(deps.codex, req.params, { model: deps.models.applyAddressPick, timeoutMs: 120_000 })
        return ok(req.requestId, { position })
      }

      // The Application email (spec #66). The writer drafts the prose; the
      // links and the signature come from the Profile (ADR 0006), and a
      // failed Draft check still answers the Draft, marked unchecked (ADR 0004).
      case 'email.draft': {
        const profile = getProfile(db)
        const out = await draftApplicationEmail(
          { writer: deps.runner, checker: deps.runner, models: { writer: deps.models.applicationEmail, checker: deps.models.applicationEmailCheck } },
          {
            jobText: req.params.jobText,
            company: req.params.company,
            title: req.params.title,
            profileSummary: buildProfileSummary(profile, getAnswerBank(db)),
            cvText: req.params.cvText ?? null,
            projectNotes: readProjectNotes(deps.config.projectsPaths),
            pageSubject: req.params.pageSubject,
            // The language the user switched to, or the Job posting's own.
            language: req.params.language ?? postingLanguage(req.params.jobText),
            instruction: req.params.instruction?.trim() || null,
          },
          profile,
        )
        return ok(req.requestId, out)
      }

      // A Learned wording (ticket #35): the Option the user accepted for a
      // keyed Field, stored with the key and the Value it stood for.
      case 'wording.learn': {
        if (!isFieldKey(req.params.key)) return fail(req.requestId, 'bad_request', `unknown key: ${String(req.params.key)}`)
        return ok(req.requestId, { learned: learnWording(db, req.params) })
      }

      case 'selector.get':
        return ok(req.requestId, { selector: getSelector(db, req.params.hostname, req.params.purpose) })

      case 'selector.save':
        saveSelector(db, req.params.hostname, req.params.purpose, req.params.selector)
        return ok(req.requestId, { selector: req.params.selector })

      // "Not the job description" (spec #41). A site with no saved spot
      // answers cleared: false and nothing changes.
      case 'selector.clear':
        return ok(req.requestId, { cleared: clearSelector(db, req.params.hostname, req.params.purpose) })

      case 'mapping.confirm':
        saveLearnedMapping(db, normalizeQuestion(req.params.label), req.params.fieldKey)
        return ok(req.requestId, { label: normalizeQuestion(req.params.label), fieldKey: req.params.fieldKey })

      case 'qa.list':
        // No panel consumer in v1 (deliberate): this method is the executable
        // proof of the {page, done} chunking protocol. See Task 11 preamble.
        return ok(req.requestId, paginate(listAllAnswers(db), req.params.page))

      case 'applied.mark': {
        // A mark after "Open in my mail app" keeps the email as it was handed
        // over: it left through the mail app, with no Sender address, no
        // attachments and no Gmail ids (spec #66).
        const handed = req.params.email
        return ok(req.requestId, markApplied(db, {
          url: req.params.url, company: req.params.company, jobTitle: req.params.jobTitle,
          channel: req.params.channel ?? (handed === undefined ? 'form' : 'email'),
          proseAnswers: req.params.proseAnswers ?? [],
          ...(handed === undefined ? {} : {
            email: {
              ...handed, senderAddress: null, attachmentNames: [], gmailMessageId: null, gmailThreadId: null, route: 'mail_app' as const,
            },
          }),
        }))
      }

      case 'applied.check':
        return ok(req.requestId, {
          applied: checkApplied(db, req.params.url),
          appliedByAddress: checkAppliedByAddress(db, req.params.applyAddresses ?? []),
        })

      case 'applied.list':
        return ok(req.requestId, { jobs: listApplied(db) })

      // One Applied job's stored texts, read when the user opens it, so the
      // list stays small.
      case 'applied.get': {
        const texts = getAppliedTexts(db, req.params.id)
        return texts === null
          ? fail(req.requestId, 'bad_request', `no Applied job has the id ${req.params.id}`)
          : ok(req.requestId, texts)
      }

      // A Capture is written here and goes nowhere else. The log names its ATS
      // and size, never its content.
      case 'capture.save': {
        const { capturesDir, privateStringsPath } = deps.config
        const out = saveCapture(req.params, { capturesDir, privateStringsPath })
        log('info', 'capture.save', { ats: req.params.ats, chars: req.params.page.html.length, saved: out.ok })
        return out.ok ? ok(req.requestId, { path: out.path }) : fail(req.requestId, 'bad_request', out.reason)
      }

      case 'facts.extract':
        return ok(req.requestId, await runFactsExtract(deps.codex, req.params.cvText, { model: deps.models.factsExtract, timeoutMs: 240_000 }))

      // The Mail account (spec #66). Its secrets never reach a response.
      case 'mail.status':
        if (deps.mail === undefined) return noMail(req.requestId)
        return ok(req.requestId, deps.mail.status(db))

      case 'mail.connect.start':
        if (deps.mail === undefined) return noMail(req.requestId)
        return ok(req.requestId, await deps.mail.connectStart(db, req.params.clientFile))

      case 'mail.connect.finish':
        if (deps.mail === undefined) return noMail(req.requestId)
        return ok(req.requestId, await deps.mail.connectFinish(db))

      case 'mail.disconnect':
        if (deps.mail === undefined) return noMail(req.requestId)
        return ok(req.requestId, await deps.mail.disconnect(db))

      case 'mail.senders':
        if (deps.mail === undefined) return noMail(req.requestId)
        return ok(req.requestId, await deps.mail.senders(db))

      // The only path to the driver's send (spec #66, ADR 0012): this
      // request, which only the user's click on Send makes.
      case 'mail.send':
        if (deps.mail === undefined) return noMail(req.requestId)
        return ok(req.requestId, await deps.mail.send(db, req.requestId, req.params))

      // "It arrived" (ticket #83): the user's answer to an outcome the tool
      // could not know. It calls nothing.
      case 'mail.send.arrived':
        if (deps.mail === undefined) return noMail(req.requestId)
        return ok(req.requestId, deps.mail.arrived(db, req.params))
    }
    // Exhaustiveness proof: HostRequestSchema already rejected anything else.
    const never: never = req
    return fail((never as HostRequest).requestId, 'bad_request', 'unknown method')
  } catch (e) {
    if (e instanceof ClaudeError) return fail(req.requestId, e.kind, e.message)
    // Every CodexError kind exists in HOST_ERROR_KINDS, so the mapping is 1:1.
    if (e instanceof CodexError) return fail(req.requestId, e.kind, e.message)
    const mail = asMailError(e)
    if (mail !== null) {
      log('warn', 'mail request failed', { method: req.method, kind: mail.kind, message: mail.message })
      return fail(req.requestId, mail.kind, mail.message)
    }
    const message = e instanceof Error ? e.message : String(e)
    log('error', 'handler failed', { method: req.method, message })
    return fail(req.requestId, 'db', message)
  }
}
