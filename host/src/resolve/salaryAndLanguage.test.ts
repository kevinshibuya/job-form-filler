import { describe, it, expect, beforeEach, vi } from 'vitest'
import { type EnumField, type Resolution, type WidgetKind } from '@jff/shared'
import type Database from 'better-sqlite3'
import { getAnswerBank, openDb, setAnswerBank, setProfile } from '../db/repos.js'
import { handleRequest, type HandlerDeps } from '../handlers.js'
import { buildProfileSummary } from '../llm/generate.js'
import { resolveModels } from '../llm/models.js'

// Ticket #33: `salary` is an amount with its currency and period, always
// Proposed; `notice`, `earliestStart` and `remotePreference` hold one Value
// for English and one for Portuguese, and a Field takes the Value in its own
// language. Old text of all four has no Value. Every test goes through the
// host's request handler with a real in-memory database and a fake Mapping
// runner (spec #6, testing decision 2). The persona is Ada Lovelace.

type Decision = { decision: 'known_key' | 'reuse_answer' | 'custom'; knownKey?: string }

let db: Database.Database
let deps: HandlerDeps
let decide: (ref: string) => Decision

beforeEach(() => {
  db = openDb(':memory:')
  setProfile(db, { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100', country: 'United Kingdom' })
  decide = () => ({ decision: 'custom' })
  const mapping = vi.fn(async (prompt: string) =>
    [...prompt.matchAll(/^- ref=(\S+)/gm)].map((m) => {
      const d = decide(m[1]!)
      return { ref: m[1]!, decision: d.decision, knownKey: d.knownKey ?? null, answerId: null }
    }))
  const unused = { complete: vi.fn(async () => { throw new Error('claude is not part of Resolution') }) }
  deps = {
    db,
    runner: unused as unknown as HandlerDeps['runner'],
    codex: { complete: mapping } as unknown as HandlerDeps['codex'],
    models: resolveModels({}),
    config: { claudePath: '/bin/true', codexPath: '/bin/true', projectsPaths: [], dbPath: ':memory:', authCachePath: '/tmp/jff-auth.json', models: {} },
    selfCheckFn: async () => { throw new Error('not used') },
  }
})

let fid = 0
const field = (label: string, kind: WidgetKind, extra: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid: fid++, epoch: 5, label, name: null, idAttr: null, kind,
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...extra,
})

async function resolve(method: 'resolve.first' | 'resolve.mapping', ...fields: EnumField[]): Promise<Resolution[]> {
  const r = await handleRequest(deps, {
    requestId: crypto.randomUUID(), method,
    params: { epoch: 5, url: 'https://jobs.example.com/acme/1', hostname: 'jobs.example.com', company: 'Acme', jobText: 'Engineer wanted.', fields },
  })
  if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r)}`)
  const { resolutions } = r.result as { resolutions: Resolution[] }
  return fields.map((f) => resolutions.find((x) => x.handle.fid === f.fid)!)
}

async function write(values: Record<string, string>) {
  return handleRequest(deps, { requestId: crypto.randomUUID(), method: 'answerBank.set', params: { values } })
}

const SALARY = '{"amount":90000,"currency":"EUR","period":"year"}'

describe('salary is an amount with its currency and period', () => {
  it('a salary stored before this ticket has no Value: a salary Field is Needs input with the reason', async () => {
    setAnswerBank(db, { salary: 'R$ 18.000/mo' })
    const [r] = await resolve('resolve.first', field('Desired salary', 'text'))
    expect(r).toMatchObject({ tier: 'needs_input', key: 'salary', value: null })
    expect(r!.reason).toMatch(/no-value$/)
  })

  it('90000 EUR per year is Proposed on a salary text box with its currency and period, and never auto-fills', async () => {
    expect((await write({ salary: SALARY })).ok).toBe(true)
    const [first] = await resolve('resolve.first', field('Desired salary', 'text'))
    expect(first).toMatchObject({ tier: 'proposed', source: 'answer_bank', key: 'salary', value: '90000 EUR per year' })
    const [mapped] = await resolve('resolve.mapping', field('Desired salary', 'text'))
    expect(mapped!.tier).toBe('proposed')
  })

  it('a salary Mapping found is Proposed too, in the words of the Field\'s language', async () => {
    setAnswerBank(db, { salary: SALARY })
    decide = () => ({ decision: 'known_key', knownKey: 'salary' })
    const [r] = await resolve('resolve.mapping', field('Quanto você espera ganhar?', 'text'))
    expect(r).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'salary', value: '90000 EUR por ano' })
  })

  it('a Control that takes only numbers is Proposed the amount alone', async () => {
    setAnswerBank(db, { salary: SALARY })
    const [r] = await resolve('resolve.first', field('Desired salary', 'text', { numeric: true }))
    expect(r).toMatchObject({ tier: 'proposed', key: 'salary', value: '90000' })
  })

  it('the Native host refuses a salary without an amount, a currency or a period, and the stored one stays', async () => {
    setAnswerBank(db, { salary: SALARY })
    for (const bad of [
      '{"currency":"EUR","period":"year"}',
      '{"amount":90000,"period":"year"}',
      '{"amount":90000,"currency":"EUR"}',
      '{"amount":"","currency":"EUR","period":"year"}',
      '{"amount":-5,"currency":"EUR","period":"year"}',
      '{"amount":90000,"currency":"euros","period":"year"}',
      '{"amount":90000,"currency":"EUR","period":"fortnight"}',
      '90000 EUR per year',
    ]) {
      const r = await write({ salary: bad })
      expect(r, bad).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
      expect(r.ok === false && r.error.message, bad).toMatch(/salary/)
    }
    expect(getAnswerBank(db)['salary']).toBe(SALARY)
  })

  it('a write stores the canonical form: a currency in capitals and the amount as a number', async () => {
    expect((await write({ salary: '{"period":"month","currency":"brl","amount":"12500.50"}' })).ok).toBe(true)
    expect(getAnswerBank(db)['salary']).toBe('{"amount":12500.5,"currency":"BRL","period":"month"}')
  })
})

const NOTICE = JSON.stringify({ en: '30 days', pt: '30 dias' })

describe('notice, start date and remote preference hold one Value per language', () => {
  it('with both notice periods stored, an English Field auto-fills English and a Portuguese Field Portuguese', async () => {
    expect((await write({ notice: NOTICE })).ok).toBe(true)
    const [en, pt] = await resolve('resolve.first',
      field('Notice period', 'text'),
      field('Qual é o seu aviso prévio?', 'text'))
    expect(en).toMatchObject({ tier: 'auto', source: 'answer_bank', key: 'notice', value: '30 days' })
    expect(pt).toMatchObject({ tier: 'auto', source: 'answer_bank', key: 'notice', value: '30 dias' })
  })

  it('a Portuguese label with no stopword is still read as Portuguese by its key\'s own words', async () => {
    setAnswerBank(db, { notice: NOTICE })
    const [pt] = await resolve('resolve.first', field('Aviso prévio', 'text'))
    expect(pt).toMatchObject({ tier: 'auto', value: '30 dias' })
  })

  it('with only a Portuguese start date, an English Field is Proposed with it and the reason names the missing language', async () => {
    expect((await write({ earliestStart: JSON.stringify({ pt: 'Imediato' }) })).ok).toBe(true)
    const [en, pt] = await resolve('resolve.first',
      field('When can you start?', 'text'),
      field('Disponibilidade para início', 'text'))
    expect(en).toMatchObject({ tier: 'proposed', key: 'earliestStart', value: 'Imediato', reason: 'missing-language:en' })
    expect(pt).toMatchObject({ tier: 'auto', key: 'earliestStart', value: 'Imediato' })
  })

  it('a choice Control takes the Value in its language, and the other language\'s only as Proposed', async () => {
    setAnswerBank(db, { remotePreference: JSON.stringify({ en: 'Remote' }) })
    const options = ['Remote', 'Hybrid', 'On-site']
    const [en, pt] = await resolve('resolve.first',
      field('Remote preference', 'radiogroup', { options }),
      field('Qual a sua preferência de trabalho remoto?', 'select', { options: ['Remoto', 'Híbrido', 'Presencial'] }))
    expect(en).toMatchObject({ tier: 'auto', key: 'remotePreference', value: 'Remote' })
    expect(pt).toMatchObject({ tier: 'proposed', key: 'remotePreference', value: 'Remote', reason: 'missing-language:pt' })
  })

  it('a Mapping pick is Proposed in the Field\'s language, and says the missing one', async () => {
    setAnswerBank(db, { notice: JSON.stringify({ en: '30 days' }) })
    decide = () => ({ decision: 'known_key', knownKey: 'notice' })
    const [en, pt] = await resolve('resolve.mapping',
      field('How soon could you join us?', 'text'),
      field('Quando você poderia se juntar a nós?', 'text'))
    expect(en).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'notice', value: '30 days', reason: 'llm-key:notice' })
    expect(pt).toMatchObject({ tier: 'proposed', source: 'llm_key', key: 'notice', value: '30 days', reason: 'missing-language:pt' })
  })

  it('a notice period stored before this ticket has no Value in either language', async () => {
    setAnswerBank(db, { notice: '30 dias', earliestStart: 'Imediato', remotePreference: 'Remote only' })
    const rows = await resolve('resolve.first',
      field('Notice period', 'text'),
      field('Qual é o seu aviso prévio?', 'text'),
      field('Earliest start date', 'text'),
      field('Remote preference', 'text'))
    for (const r of rows) {
      expect(r).toMatchObject({ tier: 'needs_input', value: null })
      expect(r!.reason).toMatch(/no-value$/)
    }
  })

  it('a write stores both languages in the canonical form, and refuses old text or no language at all', async () => {
    expect((await write({ notice: '{"pt":" 30  dias ","en":"30 days"}' })).ok).toBe(true)
    expect(getAnswerBank(db)['notice']).toBe(NOTICE)
    for (const bad of ['30 days', '{}', '{"en":"","pt":""}', '{"fr":"30 jours"}', '{"en":30}']) {
      const r = await write({ notice: bad })
      expect(r, bad).toMatchObject({ ok: false, error: { kind: 'bad_request' } })
    }
    expect(getAnswerBank(db)['notice']).toBe(NOTICE)
  })
})

describe('the Profile summary handed to Generation', () => {
  it('shows the salary and the per-language Values in words, never their stored form', () => {
    const summary = buildProfileSummary({ fullName: 'Ada Lovelace' }, {
      salary: SALARY, notice: NOTICE, earliestStart: JSON.stringify({ pt: 'Imediato' }),
    })
    expect(summary).toContain('salary: 90000 EUR per year')
    expect(summary).toContain('notice: 30 days (English); 30 dias (Portuguese)')
    expect(summary).toContain('earliestStart: Imediato (Portuguese)')
    expect(summary).not.toMatch(/[{}"]/)
  })

  it('leaves old text of the four keys out', () => {
    const summary = buildProfileSummary({}, { salary: '100k', notice: '30 dias', remotePreference: 'Remote only' })
    expect(summary).toBe('')
  })
})
