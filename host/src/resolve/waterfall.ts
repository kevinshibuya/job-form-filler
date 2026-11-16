import type Database from 'better-sqlite3'
import {
  candidatesForKey, displayValue, isCheckboxGroup, isConsentCheckbox, isOldText, isProfileKey, type EnumField, type FieldClass, type FieldKey, type Resolution,
  type ResolveFirstResult, type ResolveResult,
} from '@jff/shared'
import {
  findExactAnswer, getAnswerById, getStoredValue, listReusableAnswers, touchAnswer,
} from '../db/repos.js'
import type { CallOpts } from '../llm/claudeCli.js'
import { CodexError, type CodexRunner } from '../llm/codexCli.js'
import { refOf, runMapping, type MappingCandidate, type MappingDecision } from '../llm/mapping.js'
import { matchOptionSet, optionEqualTo } from './choiceSets.js'
import { fieldCanHold, keyForField } from './controlKinds.js'
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
  const candidates = candidatesOf(patch)
  return {
    handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch },
    tier: patch.tier, value: patch.value ?? null, source: patch.source ?? null,
    key: patch.key ?? null, answerId: patch.answerId ?? null, reason: patch.reason,
    // Only a Field Mapping matched to nothing carries the label; every other
    // Resolution leaves the property out.
    ...(patch.fieldClass === undefined ? {} : { fieldClass: patch.fieldClass }),
    // Likewise only a Value with candidate words carries them.
    ...(candidates.length === 0 ? {} : { candidates }),
  }
}

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

/**
 * A Saved answer on a checkbox group: the stored set meets the page's Options.
 * Every stored label offered gives the whole set at `best`; some give the
 * matching Options as Proposed; none leaves the group Needs input. An answer on
 * any other Control is used whole, at `best`.
 */
function fromAnswer(
  f: EnumField, answer: string, best: 'auto' | 'proposed',
): { tier: Resolution['tier']; value: string | null; partial: '' | ':partial' | ':no-offered-option' } {
  if (!isCheckboxGroup(f)) return { tier: best, value: answer, partial: '' }
  const m = matchOptionSet(answer, f.options)
  if (m.match === 'all') return { tier: best, value: m.value, partial: '' }
  if (m.match === 'some') return { tier: 'proposed', value: m.value, partial: ':partial' }
  return { tier: 'needs_input', value: null, partial: ':no-offered-option' }
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
 * Field: a yes or a no in the language of its label, as Saved answers detect
 * it.
 */
type KeyValue = { kind: 'value'; value: string } | { kind: 'old' } | { kind: 'none' }

function keyValueOf(db: Database.Database, f: EnumField, key: FieldKey): KeyValue {
  const stored = getStoredValue(db, key)
  if (stored === null) return { kind: 'none' }
  if (isOldText(key, stored)) return { kind: 'old' }
  const value = displayValue(key, stored, detectLanguage(f.label ?? ''))
  return value === null ? { kind: 'none' } : { kind: 'value', value }
}

/** The reason suffix of a key with no Value: none stored, or only old text. */
const noValue = (kv: KeyValue): string => (kv.kind === 'old' ? 'no-value' : 'no-stored-value')

interface StepResult {
  byRef: Map<string, Resolution>
}

/**
 * Tiers 0 to 3: everything that needs no model. It is handed no runner, so it
 * cannot call one. A Field it cannot decide comes back in `pending`.
 */
function firstStep(db: Database.Database, fields: EnumField[]): StepResult & { pending: EnumField[] } {
  const byRef = new Map<string, Resolution>()
  const unresolved: EnumField[] = []

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
    let key = label === '' ? null : keyForField(f, recognize(label, db, f.kind))
    // On a checkbox group a key answers only with an Option equal to its stored
    // Value. With none, the group goes on as if the key had not matched.
    if (key !== null && isCheckboxGroup(f)) {
      const kv = keyValueOf(db, f, key)
      const option = kv.kind === 'value' ? keyValueFor(f, kv.value) : null
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
          tier: 'auto', source: isProfileKey(key) ? 'profile' : 'answer_bank',
          key, value: kv.value, reason: `recognizer:${key}`,
        }))
      } else {
        // B5c: the recognizer intercepts BEFORE tier 3, so a saved answer under
        // this exact question used to be invisible. Try it before needs_input.
        const hit = exactAnswer(db, label)
        if (hit !== null) {
          touchAnswer(db, hit.id)
          byRef.set(ref, res(f, {
            tier: 'auto', source: 'saved_answer', key, value: hit.answer,
            answerId: hit.id, reason: 'exact-match:key-fallback',
          }))
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
        }))
        continue
      }
    }

    unresolved.push(f)
  }

  return { byRef, pending: unresolved }
}

/** Tiers 4 and 5: one Mapping call over the given Fields, and none when empty. */
async function mappingStep(
  deps: WaterfallDeps, input: WaterfallInput, unresolved: EnumField[],
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
        const kv = keyValueOf(db, f, key)
        const value = kv.kind === 'value' ? keyValueFor(f, kv.value) : null
        if (value !== null) {
          byRef.set(ref, res(f, { tier: 'proposed', source: 'llm_key', key, value, reason: `llm-key:${key}` }))
          continue
        }
        if (kv.kind === 'value') {
          // A group that offers no Option equal to the stored Value.
          byRef.set(ref, res(f, { tier: 'needs_input', reason: `llm-key:${key}:no-offered-option` }))
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
            ? res(f, { tier: 'needs_input', reason: `llm-reuse:${row.id}${out.partial}` })
            : res(f, { tier: out.tier, source: 'llm_reuse', value: out.value, answerId: row.id, reason: `llm-reuse:${row.id}${out.partial}` }))
        } else {
          byRef.set(ref, res(f, { tier: 'needs_input', reason: 'company-specific' }))
        }
        continue
      }

      byRef.set(ref, unmatched(f, 'custom', d.fieldClass))
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
    resolutions: input.fields.flatMap((f) => byRef.get(refOf(f)) ?? []),
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
  const mapped = await mappingStep(deps, input, first.pending)
  return {
    epoch: input.epoch,
    resolutions: input.fields.map((f) => first.byRef.get(refOf(f)) ?? mapped.byRef.get(refOf(f))!),
    llmError: mapped.llmError,
  }
}
