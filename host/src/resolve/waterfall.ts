import type Database from 'better-sqlite3'
import {
  isConsentCheckbox, isProfileKey, type EnumField, type FieldKey, type Resolution,
  type ResolveFirstResult, type ResolveResult,
} from '@jff/shared'
import {
  findExactAnswer, getAnswerById, getStoredValue, listReusableAnswers, touchAnswer,
} from '../db/repos.js'
import type { CallOpts } from '../llm/claudeCli.js'
import { CodexError, type CodexRunner } from '../llm/codexCli.js'
import { refOf, runMapping, type MappingCandidate, type MappingDecision } from '../llm/mapping.js'
import { canHold, keyFor } from './controlKinds.js'
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

function res(f: EnumField, patch: Partial<Resolution> & { tier: Resolution['tier']; reason: string }): Resolution {
  return {
    handle: { frameId: f.frameId, fid: f.fid, epoch: f.epoch },
    tier: patch.tier, value: patch.value ?? null, source: patch.source ?? null,
    key: patch.key ?? null, answerId: patch.answerId ?? null, reason: patch.reason,
  }
}

// B5c: the exact reusable-answer lookup, shared by tier 3 and both
// no-stored-value fallbacks. company_specific rows stay unusable here.
function exactAnswer(db: Database.Database, label: string) {
  const hit = findExactAnswer(db, normalizeQuestion(label), detectLanguage(label))
  return hit !== null && hit.reusability === 'reusable' ? hit : null
}

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
      const pageKey = label === '' ? null : keyFor(f.kind, recognize(label, db))
      byRef.set(ref, res(f, { tier: 'auto', source: 'page', key: pageKey, value: f.currentValue, reason: 'already-on-page' }))
      continue
    }

    // 2 — deterministic recognizers + user-confirmed learned mappings. A hit on
    //     a Control that cannot hold the key's Value is not a hit: the Field goes
    //     on to tier 3 and Mapping as if nothing had matched.
    const key = label === '' ? null : keyFor(f.kind, recognize(label, db))
    if (key !== null) {
      const value = getStoredValue(db, key)
      if (value !== null) {
        byRef.set(ref, res(f, {
          tier: 'auto', source: isProfileKey(key) ? 'profile' : 'answer_bank',
          key, value, reason: `recognizer:${key}`,
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
          byRef.set(ref, res(f, { tier: 'needs_input', key, reason: `recognizer:${key}:no-stored-value` }))
        }
      }
      continue
    }

    // 3 — exact saved-answer match, language aware. company_specific rows are
    //     deliberately NOT usable here (company-specificity guard).
    if (label !== '') {
      const hit = exactAnswer(db, label)
      if (hit !== null) {
        touchAnswer(db, hit.id)
        byRef.set(ref, res(f, { tier: 'auto', source: 'saved_answer', value: hit.answer, answerId: hit.id, reason: 'exact-match' }))
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
        byRef.set(ref, res(f, { tier: 'needs_input', reason: `llm-error:${llmError.kind}` }))
        continue
      }
      const d = decisions.get(ref)
      if (d === undefined) {
        byRef.set(ref, res(f, { tier: 'needs_input', reason: 'llm-unavailable' }))
        continue
      }

      if (d.decision === 'known_key' && d.knownKey !== null) {
        const key: FieldKey = d.knownKey
        // Mapping is told the Control kind, but its answer is checked anyway.
        if (!canHold(f.kind, key)) {
          byRef.set(ref, res(f, { tier: 'needs_input', reason: `llm-key:${key}:wrong-control` }))
          continue
        }
        const value = getStoredValue(db, key)
        if (value !== null) {
          byRef.set(ref, res(f, { tier: 'proposed', source: 'llm_key', key, value, reason: `llm-key:${key}` }))
          continue
        }
        // B5c, defense in depth: every LABELLED field already tried tier 3
        // before reaching the LLM, so this only fires if the ordering above
        // ever changes — cheap insurance on a recall-critical path. Tier stays
        // `proposed`: the key is LLM-derived ("LLM results are PROPOSED").
        const fallbackLabel = (f.label ?? '').trim()
        const hit = fallbackLabel === '' ? null : exactAnswer(db, fallbackLabel)
        if (hit !== null) {
          touchAnswer(db, hit.id)
          byRef.set(ref, res(f, {
            tier: 'proposed', source: 'saved_answer', key, value: hit.answer,
            answerId: hit.id, reason: 'exact-match:key-fallback',
          }))
        } else {
          byRef.set(ref, res(f, { tier: 'needs_input', key, reason: `llm-key:${key}:no-stored-value` }))
        }
        continue
      }

      if (d.decision === 'reuse_answer' && d.answerId !== null) {
        const row = getAnswerById(db, d.answerId)
        // Second guard: even a validated id must not be company_specific.
        if (row !== null && row.reusability === 'reusable') {
          byRef.set(ref, res(f, { tier: 'proposed', source: 'llm_reuse', value: row.answer, answerId: row.id, reason: `llm-reuse:${row.id}` }))
        } else {
          byRef.set(ref, res(f, { tier: 'needs_input', reason: 'company-specific' }))
        }
        continue
      }

      byRef.set(ref, res(f, { tier: 'needs_input', reason: 'custom' }))
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
 * `resolve.mapping`, and `resolve` through it: Mapping over the Fields the
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

/**
 * `resolve`: the first step, then Mapping on what it left pending, in one
 * request. Kept until the panel moves onto the two requests (#16, #18).
 */
export const resolveFields = resolveMapping
