import type Database from 'better-sqlite3'
import {
  isProfileKey, type EnumField, type FieldKey, type Resolution, type ResolveResult,
} from '@jff/shared'
import {
  findExactAnswer, getAnswerById, getStoredValue, listReusableAnswers, touchAnswer,
} from '../db/repos.js'
import { ClaudeError, type CallOpts, type ClaudeRunner } from '../llm/claudeCli.js'
import { refOf, runMapping, type MappingCandidate, type MappingDecision } from '../llm/mapping.js'
import { detectLanguage, normalizeQuestion } from './normalize.js'
import { recognize } from './recognizers.js'

export interface WaterfallDeps {
  db: Database.Database
  runner: ClaudeRunner
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

export async function resolveFields(deps: WaterfallDeps, input: WaterfallInput): Promise<ResolveResult> {
  const { db } = deps
  const byRef = new Map<string, Resolution>()
  const unresolved: EnumField[] = []

  // B5c: the exact reusable-answer lookup, shared by tier 3 and both
  // no-stored-value fallbacks. company_specific rows stay unusable here.
  const exactAnswer = (label: string) => {
    const hit = findExactAnswer(db, normalizeQuestion(label), detectLanguage(label))
    return hit !== null && hit.reusability === 'reusable' ? hit : null
  }

  for (const f of input.fields) {
    const ref = refOf(f)
    const label = (f.label ?? '').trim()

    // 0 — EEO/demographic: skipped forever, never sent to the LLM, never filled.
    if (f.demographic) { byRef.set(ref, res(f, { tier: 'skipped', reason: 'eeo' })); continue }

    // 1 — already on the page (typically the ATS resume auto-parse). Treated as
    //     filled, not blank; the panel does not re-fill a page-sourced value.
    if (f.currentValue !== null && f.currentValue.trim() !== '') {
      // B5a: harvest the key too — a page value under a recognized label is a
      // learnable fact (Ashby's resume auto-parse fills these), and save-side
      // learning needs the key to route it to profile/answer_bank.
      const pageKey = label === '' ? null : recognize(label, db)
      byRef.set(ref, res(f, { tier: 'auto', source: 'page', key: pageKey, value: f.currentValue, reason: 'already-on-page' }))
      continue
    }

    // 2 — deterministic recognizers + user-confirmed learned mappings.
    const key = label === '' ? null : recognize(label, db)
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
        const hit = exactAnswer(label)
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
      const hit = exactAnswer(label)
      if (hit !== null) {
        touchAnswer(db, hit.id)
        byRef.set(ref, res(f, { tier: 'auto', source: 'saved_answer', value: hit.answer, answerId: hit.id, reason: 'exact-match' }))
        continue
      }
    }

    unresolved.push(f)
  }

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
      decisions = await runMapping(deps.runner, {
        fields: unresolved, jobText: input.jobText, company: input.company, candidates,
      }, deps.mappingOpts)
    } catch (e) {
      const err = e instanceof ClaudeError ? e : new ClaudeError('process', String(e))
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
        const hit = fallbackLabel === '' ? null : exactAnswer(fallbackLabel)
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

  return {
    epoch: input.epoch,
    resolutions: input.fields.map((f) => byRef.get(refOf(f))!),
    llmError,
  }
}
