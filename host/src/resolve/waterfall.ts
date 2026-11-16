import type Database from 'better-sqlite3'
import {
  RULE_TABLE, VALUE_TYPE_OF, candidatesForKey, cityParts, displayValue, isCheckboxGroup, isConsentCheckbox, isOldText, isProfileKey,
  languageValues, phoneParts, salaryOf, salaryWords, yesNoCandidates,
  type EnumField, type FieldClass, type FieldKey, type Resolution, type ResolveFirstResult, type ResolveResult,
} from '@jff/shared'
import {
  findExactAnswer, getAnswerById, getStoredValue, listReusableAnswers, touchAnswer,
} from '../db/repos.js'
import type { CallOpts } from '../llm/claudeCli.js'
import { CodexError, type CodexRunner } from '../llm/codexCli.js'
import { refOf, runMapping, type MappingCandidate, type MappingDecision } from '../llm/mapping.js'
import { matchOptionSet, optionEqualTo } from './choiceSets.js'
import { canHold, fieldCanHold, keyForField } from './controlKinds.js'
import { KEY_OF, NAMES_REGION, countryAnswer, countryQuestionOf, type CountryQuestion } from './countryAnswers.js'
import { detectLanguage, normalizeQuestion } from './normalize.js'
import { recognize } from './recognizers.js'

export interface WaterfallDeps {
  db: Database.Database
  codex: CodexRunner
  /** The model + budget the mapping call runs under. */
  mappingOpts: CallOpts
}

export interface WaterfallInput {
  epoch: number
  url: string
  hostname: string
  company: string | null
  jobText: string
  fields: EnumField[]
}

/** Sources whose Value is a Known key's own stored Value. */
const KEY_VALUE_SOURCES: ReadonlySet<Resolution['source']> = new Set(['profile', 'answer_bank', 'llm_key'])

/**
 * The candidate words a Resolution carries: those of a Known key's stored
 * Value, by the rule table. A Saved answer or a page value filed under a key
 * is not that key's Value and gets none, nor does a Value with no rule.
 */
function candidatesOf(patch: Partial<Resolution>): string[] {
  const { key, value, source } = patch
  if (key == null || value == null || !KEY_VALUE_SOURCES.has(source ?? null)) return []
  return candidatesForKey(key, value)
}

function res(f: EnumField, patch: Partial<Resolution> & { tier: Resolution['tier']; reason: string }): Resolution {
  const candidates = patch.candidates ?? candidatesOf(patch)
  return {
    handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch },
    tier: patch.tier, value: patch.value ?? null, source: patch.source ?? null,
    key: patch.key ?? null, answerId: patch.answerId ?? null, reason: patch.reason,
    // Only a Field Mapping matched to nothing carries the label; every other
    // Resolution leaves the property out.
    ...(patch.fieldClass === undefined ? {} : { fieldClass: patch.fieldClass }),
    // Likewise only a Value with candidate words carries them.
    ...(candidates.length === 0 ? {} : { candidates }),
    // And only a row with no Value but an identified stored one carries that.
    ...(patch.identifiedValue === undefined ? {} : { identifiedValue: patch.identifiedValue }),
  }
}

/**
 * A Resolution of the `phone` key whose Value is the stored phone carries the
 * phone's parts, so a Fill can set the country selector beside a phone box.
 * The phone's country depends on the stored `country`, which `res` does not
 * see, hence a pass over the finished Resolutions.
 */
function withPhoneParts(db: Database.Database, r: Resolution): Resolution {
  if (r.key !== 'phone' || r.value === null || !KEY_VALUE_SOURCES.has(r.source)) return r
  const parts = phoneParts(r.value, getStoredValue(db, 'country'))
  return parts === null ? r : { ...r, phone: parts }
}

/**
 * A Resolution of the `city` key whose Value is the stored city and whose
 * Control is a type-to-search dropdown carries the names of the stored
 * country, so the Fill types the city alone and picks the result that names
 * both. A text box takes the city as it is and carries none.
 */
function withCityParts(db: Database.Database, f: EnumField, r: Resolution): Resolution {
  if (r.key !== 'city' || r.value === null || !KEY_VALUE_SOURCES.has(r.source) || f.kind !== 'combobox') return r
  return { ...r, city: cityParts(getStoredValue(db, 'country')) }
}

/** The parts a Fill needs beside the Value, added once the Resolution is decided. */
const withFillParts = (db: Database.Database, f: EnumField, r: Resolution): Resolution =>
  withCityParts(db, f, withPhoneParts(db, r))

/**
 * A Field Mapping left unmatched, or never got to answer for: Needs input,
 * labelled. Without a label Mapping gave, it is a Personal-fact Field, so a
 * degraded Mapping errs toward asking the user rather than drafting.
 */
function unmatched(f: EnumField, reason: string, fieldClass: FieldClass | null = null): Resolution {
  return res(f, { tier: 'needs_input', reason, fieldClass: fieldClass ?? 'personal_fact' })
}

// B5c: the exact reusable-answer lookup, shared by tier 3 and both
// no-stored-value fallbacks. company_specific rows stay unusable here.
function exactAnswer(db: Database.Database, label: string) {
  const hit = findExactAnswer(db, normalizeQuestion(label), detectLanguage(label))
  return hit !== null && hit.reusability === 'reusable' ? hit : null
}

/** Controls that take exactly one of their Options. */
const SINGLE_CHOICE_KINDS: ReadonlySet<EnumField['kind']> = new Set(['select', 'combobox', 'radiogroup', 'choice'])

/**
 * A Saved answer meets the page's Options wherever the Scan saw them.
 * On a checkbox group the stored set does: every stored label offered gives
 * the whole set at `best`; some give the matching Options as Proposed; none
 * leaves the group Needs input. On a single-choice Control with Options, an
 * answer equal to one Option gives that Option, in the page's wording, at
 * `best`; equal to none, it is not offered at all and the Field is Needs
 * input, so a paragraph of prose never reaches a Yes/No dropdown. A dropdown
 * that showed no Options at Scan, and every other Control, takes the answer
 * whole: a dropdown's Options are matched at Fill (ADR 0009).
 */
function fromAnswer(
  f: EnumField, answer: string, best: 'auto' | 'proposed',
): { tier: Resolution['tier']; value: string | null; partial: '' | ':partial' | ':no-offered-option'; identifiedValue?: string } {
  // Equal to no Option, the answer is not the Value; it is what the model pick
  // is asked with once a Fill has read the Options (ticket #34).
  const noOffered = { tier: 'needs_input', value: null, partial: ':no-offered-option', identifiedValue: answer } as const
  if (SINGLE_CHOICE_KINDS.has(f.kind) && f.options.length > 0) {
    const option = optionEqualTo(answer, f.options)
    return option === null ? noOffered : { tier: best, value: option, partial: '' }
  }
  if (!isCheckboxGroup(f)) return { tier: best, value: answer, partial: '' }
  const m = matchOptionSet(answer, f.options)
  if (m.match === 'all') return { tier: best, value: m.value, partial: '' }
  if (m.match === 'some') return { tier: 'proposed', value: m.value, partial: ':partial' }
  return noOffered
}

/**
 * A stored Known key Value as this Control takes it: on a checkbox group only
 * the one Option equal to it, in the page's wording, and null when none is.
 */
function keyValueFor(f: EnumField, stored: string): string | null {
  return isCheckboxGroup(f) ? optionEqualTo(stored, f.options) : stored
}

/**
 * What a Known key holds for this Field. A stored text that is not its key's
 * canonical form is `old`: no Value, so the Field is Needs input with the
 * reason `no-value` (shared/src/typedValues.ts). A Value is formatted for the
 * Field, in the language of its label as Saved answers detect it: a yes or a
 * no in that language's words, a salary as the amount alone on a Control that
 * takes only numbers and in words with its currency and period elsewhere, and
 * a per-language key's Value in that language.
 *
 * `proposed` holds the reason when the Value may never fill by itself: every
 * salary, so the figure is checked against the role, and a per-language Value
 * offered in the other language because none is stored in the Field's own.
 */
type KeyValue = { kind: 'value'; value: string; proposed?: string } | { kind: 'old' } | { kind: 'none' }

/** The reason on a salary row: it is always Proposed. */
export const SALARY_CHECK = 'salary-check'

/** The reason on a row offered the other language's Value: names the Field's language, the one missing. */
export const missingLanguage = (lang: 'en' | 'pt'): string => `missing-language:${lang}`

function keyValueOf(db: Database.Database, f: EnumField, key: FieldKey): KeyValue {
  const stored = getStoredValue(db, key)
  if (stored === null) return { kind: 'none' }
  if (isOldText(key, stored)) return { kind: 'old' }
  const lang = detectLanguage(f.label ?? '')
  const type = VALUE_TYPE_OF[key]
  if (type === 'amount') {
    const salary = salaryOf(stored)
    if (salary === null) return { kind: 'none' }
    return { kind: 'value', value: f.numeric === true ? String(salary.amount) : salaryWords(salary, lang), proposed: SALARY_CHECK }
  }
  if (type === 'per_language') {
    const values = languageValues(stored) ?? {}
    const own = values[lang]
    if (own !== undefined) return { kind: 'value', value: own }
    const other = values[lang === 'en' ? 'pt' : 'en']
    return other === undefined ? { kind: 'none' } : { kind: 'value', value: other, proposed: missingLanguage(lang) }
  }
  const value = displayValue(key, stored, lang)
  return value === null ? { kind: 'none' } : { kind: 'value', value }
}

/** The reason suffix of a key with no Value: none stored, or only old text. */
const noValue = (kv: KeyValue): string => (kv.kind === 'old' ? 'no-value' : 'no-stored-value')

/**
 * A question answered for the country it names (countryAnswers.ts): a yes or
 * a no in the language of the label, with the yes or no candidates for Fill.
 * A Mapping pick is never more than Proposed.
 */
function countryResolution(
  db: Database.Database, f: EnumField, question: CountryQuestion, by: 'recognizer' | 'mapping',
): Resolution {
  const key = KEY_OF[question]
  const out = countryAnswer(db, question, f.label ?? '', by === 'recognizer' ? 'recognizer' : 'llm-key')
  if (out.tier === 'needs_input') {
    // A region is not read by rule, but the stored Value the question asks
    // about is known: the model pick is asked with it once a Fill has read the
    // Options (ticket #34). Authorization and sponsorship ask about the list,
    // residence about the user's own country.
    const kv = out.reason === NAMES_REGION ? keyValueOf(db, f, question === 'residence' ? 'country' : 'workAuth') : null
    return res(f, { tier: 'needs_input', key, reason: out.reason, ...(kv?.kind === 'value' ? { identifiedValue: kv.value } : {}) })
  }
  const source = by === 'mapping' ? 'llm_key' : isProfileKey(key) ? 'profile' : 'answer_bank'
  return res(f, {
    tier: by === 'mapping' ? 'proposed' : out.tier, source, key,
    value: RULE_TABLE[detectLanguage(f.label ?? '')][out.answer][0]!,
    candidates: yesNoCandidates(out.answer), reason: out.reason,
  })
}

interface StepResult {
  byRef: Map<string, Resolution>
}

/** The identified stored Value of a Resolution patch, when it has one. */
const identified = (v: string | undefined): Partial<Resolution> => (v === undefined ? {} : { identifiedValue: v })

/**
 * Tiers 0 to 3: everything that needs no model. It is handed no runner, so it
 * cannot call one. A Field it cannot decide comes back in `pending`.
 */
function firstStep(db: Database.Database, fields: EnumField[]): StepResult & { pending: EnumField[]; identifiedOf: Map<string, string> } {
  const byRef = new Map<string, Resolution>()
  const unresolved: EnumField[] = []
  // Pending checkbox groups whose recognized key has a stored Value no Option
  // equals (ticket #34): Mapping decides them, and whatever it leaves Needs
  // input still carries that Value for the model pick.
  const identifiedOf = new Map<string, string>()

  for (const f of fields) {
    const ref = refOf(f)
    const label = (f.label ?? '').trim()

    // Consent checkbox: always the user's own act. No Known key, no Saved
    // answer, no Mapping, never ticked, and never Skipped — a required one
    // inside a demographic section still blocks submission.
    if (isConsentCheckbox(f)) { byRef.set(ref, res(f, { tier: 'needs_input', reason: 'consent-checkbox' })); continue }

    // 0 — EEO/demographic: skipped forever, never sent to the LLM, never filled.
    if (f.demographic) { byRef.set(ref, res(f, { tier: 'skipped', reason: 'eeo' })); continue }

    // 1 — already on the page (typically the ATS resume auto-parse). Treated as
    //     filled, not blank; the panel does not re-fill a page-sourced value.
    if (f.currentValue !== null && f.currentValue.trim() !== '') {
      // B5a: harvest the key too — a page value under a recognized label is a
      // learnable fact (Ashby's resume auto-parse fills these), and save-side
      // learning needs the key to route it to profile/answer_bank.
      // A key the Control cannot hold is not harvested either.
      // A group's ticked set is not a Known key Value, so none is harvested.
      const pageKey = label === '' || isCheckboxGroup(f) ? null : keyForField(f, recognize(label, db, f.kind))
      byRef.set(ref, res(f, { tier: 'auto', source: 'page', key: pageKey, value: f.currentValue, reason: 'already-on-page' }))
      continue
    }

    // 2 — deterministic recognizers + user-confirmed learned mappings. A hit on
    //     a Control that cannot hold the key's Value is not a hit: the Field goes
    //     on to tier 3 and Mapping as if nothing had matched.
    const recognized = label === '' ? null : recognize(label, db, f.kind)
    // Authorization, sponsorship and residence are answered for the country the
    // label names, never from a stored yes or no or the location line.
    const question = countryQuestionOf(recognized, label)
    if (question !== null && canHold(f.kind, KEY_OF[question])) {
      byRef.set(ref, countryResolution(db, f, question, 'recognizer'))
      continue
    }
    let key = keyForField(f, recognized)
    // On a checkbox group a key answers only with an Option equal to its stored
    // Value. With none, the group goes on as if the key had not matched.
    if (key !== null && isCheckboxGroup(f)) {
      const kv = keyValueOf(db, f, key)
      const option = kv.kind === 'value' && kv.proposed === undefined ? keyValueFor(f, kv.value) : null
      if (kv.kind === 'value' && option === null) identifiedOf.set(ref, kv.value)
      if (option !== null) {
        byRef.set(ref, res(f, {
          tier: 'auto', source: isProfileKey(key) ? 'profile' : 'answer_bank',
          key, value: option, reason: `recognizer:${key}`,
        }))
        continue
      }
      key = null
    }
    if (key !== null) {
      const kv = keyValueOf(db, f, key)
      if (kv.kind === 'value') {
        byRef.set(ref, res(f, {
          tier: kv.proposed === undefined ? 'auto' : 'proposed', source: isProfileKey(key) ? 'profile' : 'answer_bank',
          key, value: kv.value, reason: kv.proposed ?? `recognizer:${key}`,
        }))
      } else {
        // B5c: the recognizer intercepts BEFORE tier 3, so a saved answer under
        // this exact question used to be invisible. Try it before needs_input.
        const hit = exactAnswer(db, label)
        const out = hit === null ? null : fromAnswer(f, hit.answer, 'auto')
        if (hit !== null && out !== null && out.value !== null) {
          touchAnswer(db, hit.id)
          byRef.set(ref, res(f, {
            tier: out.tier, source: 'saved_answer', key, value: out.value,
            answerId: hit.id, reason: `exact-match:key-fallback${out.partial}`,
          }))
        } else if (out !== null) {
          byRef.set(ref, res(f, { tier: 'needs_input', key, reason: `exact-match:key-fallback${out.partial}`, ...identified(out.identifiedValue) }))
        } else {
          byRef.set(ref, res(f, { tier: 'needs_input', key, reason: `recognizer:${key}:${noValue(kv)}` }))
        }
      }
      continue
    }

    // 3 — exact saved-answer match, language aware. company_specific rows are
    //     deliberately NOT usable here (company-specificity guard).
    if (label !== '') {
      const hit = exactAnswer(db, label)
      if (hit !== null) {
        const out = fromAnswer(f, hit.answer, 'auto')
        if (out.value !== null) touchAnswer(db, hit.id)
        byRef.set(ref, res(f, {
          tier: out.tier, source: out.value === null ? null : 'saved_answer', value: out.value,
          answerId: out.value === null ? null : hit.id, reason: `exact-match${out.partial}`,
          ...identified(out.identifiedValue),
        }))
        continue
      }
    }

    unresolved.push(f)
  }

  return { byRef, pending: unresolved, identifiedOf: new Map([...identifiedOf].filter(([ref]) => !byRef.has(ref))) }
}

/** Tiers 4 and 5: one Mapping call over the given Fields, and none when empty. */
async function mappingStep(
  deps: WaterfallDeps, input: WaterfallInput, unresolved: EnumField[], identifiedOf: ReadonlyMap<string, string>,
): Promise<StepResult & { llmError: ResolveResult['llmError'] }> {
  const { db } = deps
  const byRef = new Map<string, Resolution>()
  let llmError: ResolveResult['llmError'] = null

  if (unresolved.length > 0) {
    const langs = new Set(unresolved.map((f) => detectLanguage(f.label ?? '')))
    const seen = new Set<number>()
    const candidates: MappingCandidate[] = []
    for (const lang of langs) {
      for (const row of listReusableAnswers(db, lang)) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        candidates.push({ id: row.id, questionRaw: row.questionRaw, answer: row.answer, language: row.language, reusability: row.reusability })
      }
    }

    let decisions = new Map<string, MappingDecision>()
    try {
      decisions = await runMapping(deps.codex, {
        fields: unresolved, jobText: input.jobText, company: input.company, candidates,
      }, deps.mappingOpts)
    } catch (e) {
      const err = e instanceof CodexError ? e : new CodexError('process', String(e))
      llmError = { kind: err.kind, message: err.message }
    }

    for (const f of unresolved) {
      const ref = refOf(f)

      if (llmError !== null) {
        byRef.set(ref, unmatched(f, `llm-error:${llmError.kind}`))
        continue
      }
      const d = decisions.get(ref)
      if (d === undefined) {
        byRef.set(ref, unmatched(f, 'llm-unavailable'))
        continue
      }

      if (d.decision === 'known_key' && d.knownKey !== null) {
        const key: FieldKey = d.knownKey
        // Mapping is told the Control kind, but its answer is checked anyway:
        // the Control must hold the key, and a place never answers a yes/no
        // question.
        if (!fieldCanHold(f, key)) {
          byRef.set(ref, res(f, { tier: 'needs_input', reason: `llm-key:${key}:wrong-control` }))
          continue
        }
        const question = countryQuestionOf(key, f.label ?? '')
        if (question !== null) {
          byRef.set(ref, countryResolution(db, f, question, 'mapping'))
          continue
        }
        const kv = keyValueOf(db, f, key)
        const value = kv.kind === 'value' ? keyValueFor(f, kv.value) : null
        if (value !== null) {
          const reason = kv.kind === 'value' && kv.proposed !== undefined ? kv.proposed : `llm-key:${key}`
          byRef.set(ref, res(f, { tier: 'proposed', source: 'llm_key', key, value, reason }))
          continue
        }
        if (kv.kind === 'value') {
          // A group that offers no Option equal to the stored Value, which is
          // what the model pick is asked with (ticket #34).
          byRef.set(ref, res(f, { tier: 'needs_input', reason: `llm-key:${key}:no-offered-option`, identifiedValue: kv.value }))
          continue
        }
        // B5c, defense in depth: every LABELLED field already tried tier 3
        // before reaching the LLM, so this only fires if the ordering above
        // ever changes — cheap insurance on a recall-critical path. Tier stays
        // `proposed`: the key is LLM-derived ("LLM results are PROPOSED").
        const fallbackLabel = (f.label ?? '').trim()
        const hit = fallbackLabel === '' ? null : exactAnswer(db, fallbackLabel)
        const out = hit === null ? null : fromAnswer(f, hit.answer, 'proposed')
        if (hit !== null && out !== null && out.value !== null) {
          touchAnswer(db, hit.id)
          byRef.set(ref, res(f, {
            tier: out.tier, source: 'saved_answer', key, value: out.value,
            answerId: hit.id, reason: `exact-match:key-fallback${out.partial}`,
          }))
        } else {
          byRef.set(ref, res(f, { tier: 'needs_input', key, reason: `llm-key:${key}:${noValue(kv)}` }))
        }
        continue
      }

      if (d.decision === 'reuse_answer' && d.answerId !== null) {
        const row = getAnswerById(db, d.answerId)
        // Second guard: even a validated id must not be company_specific.
        if (row !== null && row.reusability === 'reusable') {
          const out = fromAnswer(f, row.answer, 'proposed')
          byRef.set(ref, out.value === null
            ? res(f, { tier: 'needs_input', reason: `llm-reuse:${row.id}${out.partial}`, ...identified(out.identifiedValue) })
            : res(f, { tier: out.tier, source: 'llm_reuse', value: out.value, answerId: row.id, reason: `llm-reuse:${row.id}${out.partial}` }))
        } else {
          byRef.set(ref, res(f, { tier: 'needs_input', reason: 'company-specific' }))
        }
        continue
      }

      byRef.set(ref, unmatched(f, 'custom', d.fieldClass))
    }

    // A group the first step recognized, with a stored Value no Option equals,
    // keeps that Value on whatever Needs input row Mapping left it (ticket #34).
    for (const [ref, value] of identifiedOf) {
      const r = byRef.get(ref)
      if (r !== undefined && r.tier === 'needs_input' && r.value === null && r.identifiedValue === undefined) {
        byRef.set(ref, { ...r, identifiedValue: value })
      }
    }
  }

  return { byRef, llmError }
}

/**
 * `resolve.first`: a Resolution for every Field that needs no model, and the
 * handles of the rest. Runs no model.
 */
export function resolveFirst(db: Database.Database, input: WaterfallInput): ResolveFirstResult {
  const { byRef } = firstStep(db, input.fields)
  return {
    epoch: input.epoch,
    resolutions: input.fields.flatMap((f) => { const r = byRef.get(refOf(f)); return r === undefined ? [] : [withFillParts(db, f, r)] }),
    pending: input.fields.filter((f) => !byRef.has(refOf(f)))
      .map((f) => ({ frameId: f.frameId, fid: f.fid, epoch: f.epoch })),
  }
}

/**
 * `resolve.mapping`: Mapping over the Fields the
 * request carries. The host keeps no state between the two requests, so it does
 * not trust the panel to send only pending Fields: the first step runs again as
 * a guard, and a Field it decides (a Demographic Field, a Consent checkbox)
 * never reaches the model. On the pending Fields of a `resolve.first` reply the
 * guard decides nothing, so they all go to Mapping.
 */
export async function resolveMapping(deps: WaterfallDeps, input: WaterfallInput): Promise<ResolveResult> {
  const first = firstStep(deps.db, input.fields)
  const mapped = await mappingStep(deps, input, first.pending, first.identifiedOf)
  return {
    epoch: input.epoch,
    resolutions: input.fields.map((f) => withFillParts(deps.db, f, first.byRef.get(refOf(f)) ?? mapped.byRef.get(refOf(f))!)),
    llmError: mapped.llmError,
  }
}
