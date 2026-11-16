import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { EnumField, HostResponse, Resolution } from '@jff/shared'
import { App } from './App'
import { FieldRow } from './FieldRow'
import { ProfileEditor } from './ProfileEditor'
import { installHeldMappingHost } from './testing/heldMapping'

// Ticket #33: the Profile editor asks for a salary's amount, currency and
// period, and for an English and a Portuguese Value of the notice period, the
// earliest start date and the remote preference. Text stored before this
// ticket has no Value and is shown as a hint. The persona is Ada Lovelace.

const BASE = { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100', country: 'United Kingdom' }
const SALARY = '{"amount":90000,"currency":"EUR","period":"year"}'

const box = (name: string): HTMLInputElement | HTMLSelectElement =>
  screen.getByLabelText(name) as HTMLInputElement | HTMLSelectElement
const type = (name: string, value: string): void => { fireEvent.change(box(name), { target: { value } }) }
const hint = (key: string): string | null => document.querySelector(`[data-jff-fact-hint="${key}"]`)?.textContent ?? null
const problem = (key: string): string | null => document.querySelector(`[data-jff-fact-problem="${key}"]`)?.textContent ?? null
const saveButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Save facts' }) as HTMLButtonElement

function editor(values: Record<string, string>) {
  const onSave = vi.fn()
  render(<ProfileEditor values={values} loaded={true} onSave={onSave} />)
  const saved = (): [Record<string, string>, Record<string, string>] => {
    fireEvent.click(saveButton())
    return onSave.mock.calls.at(-1) as [Record<string, string>, Record<string, string>]
  }
  return { saved, onSave }
}

describe('the salary in the Profile editor', () => {
  it('asks for the amount, the currency and the period, and stores the three as one salary', () => {
    const { saved } = editor(BASE)
    expect(box('Salary amount').tagName).toBe('INPUT')
    expect(box('Salary currency').tagName).toBe('INPUT')
    expect(box('Salary period').tagName).toBe('SELECT')
    type('Salary amount', '90000')
    type('Salary currency', 'eur')
    type('Salary period', 'year')
    const [profile, bank] = saved()
    expect(bank).toMatchObject({ salary: SALARY })
    expect('salary' in profile).toBe(false)
  })

  it('shows a stored salary by its three parts, and an untouched save keeps it', () => {
    const { saved } = editor({ ...BASE, salary: SALARY })
    expect(box('Salary amount').value).toBe('90000')
    expect(box('Salary currency').value).toBe('EUR')
    expect(box('Salary period').value).toBe('year')
    expect(saved()[1]).toMatchObject({ salary: SALARY })
  })

  it('a salary missing its currency or its period holds the save, and says why beside it', () => {
    const { onSave } = editor(BASE)
    type('Salary amount', '90000')
    expect(saveButton().disabled).toBe(true)
    expect(problem('salary')).toMatch(/amount, a currency and a period/)
    type('Salary currency', 'EUR')
    expect(saveButton().disabled).toBe(true)
    type('Salary period', 'month')
    expect(saveButton().disabled).toBe(false)
    expect(problem('salary')).toBeNull()
    fireEvent.click(saveButton())
    expect(onSave.mock.calls.at(-1)![1]).toMatchObject({ salary: '{"amount":90000,"currency":"EUR","period":"month"}' })
  })

  it('clearing the three parts deletes the stored salary', () => {
    const { saved } = editor({ ...BASE, salary: SALARY })
    type('Salary amount', '')
    type('Salary currency', '')
    type('Salary period', '')
    expect(saved()[1]).toMatchObject({ salary: '' })
  })

  it('a salary stored before this ticket has no Value: its text is a hint, the parts are empty, and an untouched save keeps it', () => {
    const { saved } = editor({ ...BASE, salary: 'R$ 18.000/mo' })
    expect(hint('salary')).toContain('R$ 18.000/mo')
    expect(box('Salary amount').value).toBe('')
    expect(box('Salary currency').value).toBe('')
    expect(box('Salary period').value).toBe('')
    expect('salary' in saved()[1]).toBe(false)
  })
})

const LANGUAGE_KEYS = [
  ['notice', 'Notice period'],
  ['earliestStart', 'Earliest start date'],
  ['remotePreference', 'Remote preference'],
] as const

describe('the per-language Values in the Profile editor', () => {
  it('shows an English and a Portuguese box for each of the three keys, and stores both languages', () => {
    const { saved } = editor(BASE)
    type('Notice period in English', '30 days')
    type('Notice period in Portuguese', '30 dias')
    type('Earliest start date in English', 'Immediately')
    type('Earliest start date in Portuguese', 'Imediato')
    type('Remote preference in English', 'Remote')
    type('Remote preference in Portuguese', 'Remoto')
    const [profile, bank] = saved()
    expect(bank).toMatchObject({
      notice: '{"en":"30 days","pt":"30 dias"}',
      earliestStart: '{"en":"Immediately","pt":"Imediato"}',
      remotePreference: '{"en":"Remote","pt":"Remoto"}',
    })
    for (const [key] of LANGUAGE_KEYS) expect(key in profile).toBe(false)
  })

  it('stores one language alone when only one is entered', () => {
    const { saved } = editor(BASE)
    type('Earliest start date in Portuguese', 'Imediato')
    expect(saved()[1]).toMatchObject({ earliestStart: '{"pt":"Imediato"}' })
  })

  it('shows both stored languages, and clearing both deletes the key', () => {
    const { saved } = editor({ ...BASE, notice: '{"en":"30 days","pt":"30 dias"}' })
    expect(box('Notice period in English').value).toBe('30 days')
    expect(box('Notice period in Portuguese').value).toBe('30 dias')
    type('Notice period in English', '')
    type('Notice period in Portuguese', '')
    expect(saved()[1]).toMatchObject({ notice: '' })
  })

  it('a value stored before this ticket has no Value in either language: it is a hint and an untouched save keeps it', () => {
    const { saved } = editor({ ...BASE, notice: '30 dias', remotePreference: 'Remote only' })
    expect(hint('notice')).toContain('30 dias')
    expect(hint('remotePreference')).toContain('Remote only')
    expect(box('Notice period in English').value).toBe('')
    expect(box('Notice period in Portuguese').value).toBe('')
    const bank = saved()[1]
    expect('notice' in bank).toBe(false)
    expect('remotePreference' in bank).toBe(false)
  })
})

describe('the salary and per-language editor against the host', () => {
  const host = installHeldMappingHost()
  let calls: { method: string; params: unknown }[]

  beforeEach(() => {
    host.nothingPending = true
    calls = []
    const bridge = window.__jffHostBridge!
    window.__jffHostBridge = async (req): Promise<HostResponse> => {
      calls.push({ method: req.method, params: req.params })
      if (req.method === 'answerBank.get') {
        return { requestId: req.requestId, ok: true, result: { salary: 'R$ 18.000/mo', notice: '30 dias' } }
      }
      if (req.method === 'answerBank.set') {
        return { requestId: req.requestId, ok: true, result: (req.params as { values: Record<string, string> }).values }
      }
      return bridge(req)
    }
  })

  it('old entries show as hints, and what is entered reaches the host in its stored form', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit your facts' }))
    await waitFor(() => { expect(saveButton().disabled).toBe(false) })
    expect(hint('salary')).toContain('R$ 18.000/mo')
    expect(hint('notice')).toContain('30 dias')
    type('Salary amount', '90000')
    type('Salary currency', 'EUR')
    type('Salary period', 'year')
    type('Notice period in English', '30 days')
    type('Notice period in Portuguese', '30 dias')
    fireEvent.click(saveButton())
    await waitFor(() => { expect(calls.some((c) => c.method === 'answerBank.set')).toBe(true) })
    const set = calls.find((c) => c.method === 'answerBank.set')!.params as { values: Record<string, string> }
    expect(set.values.salary).toBe(SALARY)
    expect(set.values.notice).toBe('{"en":"30 days","pt":"30 dias"}')
  })
})

describe('a salary or per-language row', () => {
  const field = (label: string): EnumField => ({
    frameId: 0, fid: 1, epoch: 1, label, name: null, idAttr: null,
    kind: 'text', options: [], required: false, visible: true, currentValue: null, demographic: false,
  })
  const resolution = (patch: Partial<Resolution>): Resolution => ({
    handle: { frameId: 0, fid: 1, epoch: 1 }, tier: 'proposed', value: null,
    source: 'answer_bank', key: 'salary', answerId: null, reason: 'salary-check', ...patch,
  })
  const noop = (): undefined => undefined
  const props = {
    edited: null as string | null, onEdit: noop, onAccept: noop, onGenerate: noop, onFill: noop, onSaveFact: noop,
    generating: false, filled: false, acting: null, locked: false, facts: {} as Record<string, string>, factsReady: true,
  }
  const show = (label: string, r: Resolution): void => {
    render(<ul><FieldRow {...props} row={{ ref: '0:1', field: field(label), resolution: r }} /></ul>)
  }

  it('a salary row asks for the figure to be checked against the role', () => {
    show('Desired salary', resolution({ value: '90000 EUR per year' }))
    expect(screen.getByText(/Check the figure against this role/)).toBeTruthy()
  })

  it('a row offered the other language\'s Value names the language that is missing', () => {
    show('When can you start?', resolution({ key: 'earliestStart', value: 'Imediato', reason: 'missing-language:en' }))
    expect(screen.getByText(/no English answer stored/)).toBeTruthy()
  })

  it('offers no Save to profile: these Values are entered in the Profile editor', () => {
    show('Notice period', resolution({ tier: 'needs_input', key: 'notice', source: null, reason: 'recognizer:notice:no-value' }))
    expect(screen.queryByRole('button', { name: 'Save to profile' })).toBeNull()
  })
})
