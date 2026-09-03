import { describe, it, expect } from 'vitest'
import type { EnumField, Resolution } from '@jff/shared'
import { buildSaveItems, mergeStoredSnapshots, suggestReusability } from './save'

const field = (fid: number, label: string, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid, epoch: 1, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})
const res = (fid: number, patch: Partial<Resolution> = {}): Resolution => ({
  handle: { frameId: 0, fid, epoch: 1 }, tier: 'needs_input', value: null, source: null,
  key: null, answerId: null, reason: 'custom', ...patch,
})

const base = { panelEdits: {}, snapshot: {}, company: 'Acme' }

describe('suggestReusability', () => {
  it('flags a "why this company" question as company specific', () => {
    expect(suggestReusability('Why do you want to work here?', 'Acme')).toBe('company_specific')
    expect(suggestReusability('Why Acme?', 'Acme')).toBe('company_specific')
    expect(suggestReusability('Por que voce quer trabalhar aqui?', 'Acme')).toBe('company_specific')
  })

  it('flags a question naming the company as company specific even without a why', () => {
    expect(suggestReusability('What excites you about Acme?', 'Acme')).toBe('company_specific')
  })

  it('treats a generic experience question as reusable', () => {
    expect(suggestReusability('How many years of TypeScript do you have?', 'Acme')).toBe('reusable')
    expect(suggestReusability('Describe a hard bug you fixed.', null)).toBe('reusable')
  })
})

describe('buildSaveItems', () => {
  it('writes a value the user typed in the panel for a field the engine left empty', () => {
    const items = buildSaveItems({
      ...base,
      fields: [field(0, 'Describe a hard bug you fixed.')],
      resolutions: [res(0)],
      panelEdits: { '0:0': 'The websocket reconnect storm.' },
    })
    expect(items).toEqual([{
      handle: { frameId: 0, fid: 0, epoch: 1 },
      questionRaw: 'Describe a hard bug you fixed.',
      answer: 'The websocket reconnect storm.',
      reusability: 'reusable',
      fieldKey: null,
    }])
  })

  it('lets the on-page snapshot beat a panel edit', () => {
    const items = buildSaveItems({
      ...base,
      fields: [field(0, 'Q')],
      resolutions: [res(0)],
      panelEdits: { '0:0': 'panel version' },
      snapshot: { '0:0': 'what I actually typed on the page' },
    })
    expect(items[0]!.answer).toBe('what I actually typed on the page')
  })

  it('lets a panel edit beat the engine value', () => {
    const items = buildSaveItems({
      ...base,
      fields: [field(0, 'Q')],
      resolutions: [res(0, { tier: 'auto', value: 'engine value', source: 'saved_answer' })],
      panelEdits: { '0:0': 'corrected by hand' },
    })
    expect(items[0]!.answer).toBe('corrected by hand')
  })

  it('does NOT re-save a value that equals what the engine already filled', () => {
    expect(buildSaveItems({
      ...base,
      fields: [field(0, 'Q')],
      resolutions: [res(0, { tier: 'auto', value: 'same', source: 'saved_answer' })],
      snapshot: { '0:0': 'same' },
    })).toEqual([])
  })

  it('drops a corrected factual field entirely: Save answers writes no fact anywhere', () => {
    // It used to travel here with fieldKey 'salary' and the host wrote it into
    // answer_bank. Now the only way a fact is stored is "Save to profile".
    const items = buildSaveItems({
      ...base,
      fields: [field(0, 'Desired salary')],
      resolutions: [res(0, { tier: 'auto', value: 'R$ 18k', source: 'answer_bank', key: 'salary' })],
      snapshot: { '0:0': 'R$ 22k' },
    })
    expect(items).toEqual([])
  })

  it('drops a needs_input row that carries a key, even with a panel edit behind it', () => {
    expect(buildSaveItems({
      ...base,
      fields: [field(0, 'GitHub')],
      resolutions: [res(0, { tier: 'needs_input', key: 'github' })],
      panelEdits: { '0:0': 'https://github.com/x' },
    })).toEqual([])
  })

  it('still emits a keyless row, with a null fieldKey', () => {
    const items = buildSaveItems({
      ...base,
      fields: [field(0, 'Describe a hard problem you solved')],
      resolutions: [res(0, { tier: 'needs_input', key: null })],
      panelEdits: { '0:0': 'Because the work is interesting.' },
    })
    expect(items).toEqual([{
      handle: { frameId: 0, fid: 0, epoch: 1 },
      questionRaw: 'Describe a hard problem you solved',
      answer: 'Because the work is interesting.',
      reusability: 'reusable',
      fieldKey: null,
    }])
  })

  // The three exclusion rules below are kept DELIBERATELY INDEPENDENT. The obvious
  // fixture (demographic AND tier 'skipped' AND engine === final) trips all three
  // guards at once, so any one of them could be deleted with the suite still green
  // — a vacuous assertion on three privacy/safety rules. Each test isolates one guard.
  it('never saves a demographic field, even if the waterfall did not mark it skipped', () => {
    expect(buildSaveItems({
      ...base,
      fields: [field(0, 'Gender', { demographic: true })],
      resolutions: [res(0, { tier: 'auto', value: null, source: null })],
      snapshot: { '0:0': 'Man' },
    })).toEqual([])
  })

  it('never saves a field the engine skipped, even when it is not demographic', () => {
    expect(buildSaveItems({
      ...base,
      fields: [field(0, 'Type the characters you see')],
      resolutions: [res(0, { tier: 'skipped', reason: 'captcha' })],
      snapshot: { '0:0': 'x7f2q' },
    })).toEqual([])
  })

  it('never saves a value that was already on the page, even after the user edits it there', () => {
    // engine !== final and key === null here, so ONLY the keyless-page guard can drop this row.
    expect(buildSaveItems({
      ...base,
      fields: [field(0, 'First Name')],
      resolutions: [res(0, { tier: 'auto', value: 'Kevin', source: 'page' })],
      snapshot: { '0:0': 'Kevin Shibuya' },
    })).toEqual([])
  })

  it('skips empty finals and unlabelled fields', () => {
    expect(buildSaveItems({
      ...base,
      fields: [field(0, 'Q'), field(1, null as unknown as string)],
      resolutions: [res(0), res(1)],
      snapshot: { '0:0': '   ', '0:1': 'has a value but no question' },
    })).toEqual([])
  })

  it('drops a field with no matching resolution instead of guessing', () => {
    expect(buildSaveItems({ ...base, fields: [field(9, 'Orphan')], resolutions: [], snapshot: { '0:9': 'x' } })).toEqual([])
  })

  it('saves a proposed answer the user corrected in the panel and then accepted', () => {
    // The panel's onAccept promotes the TIER only, never resolution.value. If it
    // overwrote the value, engine would equal final here and this correction — the
    // single most valuable thing the learning loop can capture — would vanish.
    // Keyless on purpose: a keyed row is a fact and never reaches an item at all,
    // so the tier-vs-value invariant has to be asserted on a free-text row.
    const items = buildSaveItems({
      ...base,
      fields: [field(0, 'Describe your ideal team')],
      resolutions: [res(0, { tier: 'auto', value: 'A small one.', source: 'llm_reuse', key: null })],
      panelEdits: { '0:0': 'A small one that ships.' },
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ answer: 'A small one that ships.', fieldKey: null })
  })

  // B5b: the Ashby resume auto-parse fills Full Name/Email/Phone as page-sourced
  // values. With the recognized key attached they are learnable facts; without a
  // key they stay ATS noise that must never be saved.
  it('skips a page-sourced row that carries a factual key', () => {
    // The B5b passthrough that used to route this into profile is gone. An ATS
    // that autofills a name no longer gets to write it back over the stored one.
    expect(buildSaveItems({
      ...base,
      fields: [field(0, 'First Name')],
      resolutions: [res(0, { tier: 'auto', value: 'Kevin', source: 'page', key: 'firstName' })],
    })).toEqual([])
  })

  it('skips a page-sourced keyed row whose page value the user edited', () => {
    expect(buildSaveItems({
      ...base,
      fields: [field(0, 'Email')],
      resolutions: [res(0, { tier: 'auto', value: 'k@x.com', source: 'page', key: 'email' })],
      snapshot: { '0:0': 'corrected@x.com' },
    })).toEqual([])
  })

  it('still skips a page-sourced row with NO key', () => {
    expect(buildSaveItems({
      ...base,
      fields: [field(0, 'Some ATS artifact')],
      resolutions: [res(0, { tier: 'auto', value: 'noise', source: 'page', key: null })],
    })).toEqual([])
  })
})

describe('mergeStoredSnapshots', () => {
  const snap = (epoch: number, values: Record<string, string>) => ({ epoch, values })

  it('merges rows for this tab and this epoch, keyed frameId:fid', () => {
    expect(mergeStoredSnapshots({
      'jff:snap:7:0': snap(42, { '3': 'top frame' }),
      'jff:snap:7:2': snap(42, { '1': 'sub frame' }),
    }, 7, 42)).toEqual({ '0:3': 'top frame', '2:1': 'sub frame' })
  })

  it('rejects a row from a different tab', () => {
    expect(mergeStoredSnapshots({ 'jff:snap:9:0': snap(42, { '3': 'other tab' }) }, 7, 42)).toEqual({})
  })

  it('rejects a STALE row left by a previous application on the same tab', () => {
    // This is the poisoning case: same tab, same frame, older epoch. Merging it
    // would attribute a previous application's answers to this scan's fids and
    // write them into qa_memory and answer_bank.
    expect(mergeStoredSnapshots({ 'jff:snap:7:0': snap(41, { '3': 'last application' }) }, 7, 42)).toEqual({})
  })

  it('ignores keys that are not snapshot keys at all', () => {
    expect(mergeStoredSnapshots({ 'jff:other': snap(42, { '3': 'x' }) }, 7, 42)).toEqual({})
  })
})
