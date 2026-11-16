import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { HostResponse } from '@jff/shared'
import { App } from './App'
import { ProfileEditor } from './ProfileEditor'
import { installHeldMappingHost } from './testing/heldMapping'

// Ticket #29: work authorization is the list of countries where the user may
// work, chosen in the Profile editor from the closed country list, and the
// editor no longer asks for sponsorship: its answer is derived from the list.
// A bare yes stored before the list is old text, shown as a hint. The persona
// is Ada Lovelace; the countries are not the maintainer's.

const BASE = { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550100', country: 'United Kingdom' }

const picker = (): HTMLSelectElement => screen.getByLabelText('Work authorization') as HTMLSelectElement
const chosen = (): string[] =>
  [...document.querySelectorAll('[data-jff-workauth-country]')].map((li) => li.getAttribute('data-jff-workauth-country') ?? '')
const hint = (key: string): string | null => document.querySelector(`[data-jff-fact-hint="${key}"]`)?.textContent ?? null
const add = (name: string): void => {
  const option = [...picker().options].find((o) => o.textContent === name)
  if (option === undefined) throw new Error(`the country list offers no ${name}`)
  fireEvent.change(picker(), { target: { value: option.value } })
}

function editor(values: Record<string, string>) {
  const onSave = vi.fn()
  render(<ProfileEditor values={values} loaded={true} onSave={onSave} />)
  const saved = (): [Record<string, string>, Record<string, string>] => {
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }))
    return onSave.mock.calls.at(-1) as [Record<string, string>, Record<string, string>]
  }
  return { saved }
}

describe('the work authorization list in the Profile editor', () => {
  it('chooses countries from the closed list, not a text box, and stores the list', () => {
    const { saved } = editor(BASE)
    expect(picker().tagName).toBe('SELECT')
    expect([...picker().options].map((o) => o.textContent)).toEqual(expect.arrayContaining(['Germany', 'Portugal', 'United States']))
    add('Portugal')
    add('Germany')
    expect(chosen()).toEqual(['de', 'pt'])
    const [profile, bank] = saved()
    expect(bank).toMatchObject({ workAuth: '["de","pt"]' })
    expect('workAuth' in profile).toBe(false)
  })

  it('shows a stored list by country name, and a country removed leaves the list', () => {
    const { saved } = editor({ ...BASE, workAuth: '["de","pt"]' })
    expect(chosen()).toEqual(['de', 'pt'])
    const list = document.querySelector('[data-jff-workauth="1"]') as HTMLElement
    expect(within(list).getByText('Germany')).toBeTruthy()
    expect(within(list).getByText('Portugal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Germany' }))
    expect(chosen()).toEqual(['pt'])
    expect(saved()[1]).toMatchObject({ workAuth: '["pt"]' })
  })

  it('a country already in the list is not offered again', () => {
    editor({ ...BASE, workAuth: '["de"]' })
    expect([...picker().options].map((o) => o.textContent)).not.toContain('Germany')
  })

  it('removing every country deletes the stored list', () => {
    const { saved } = editor({ ...BASE, workAuth: '["de"]' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Germany' }))
    expect(saved()[1]).toMatchObject({ workAuth: '' })
  })

  it('a bare yes stored before the list has no Value: it is a hint, no country is chosen, and an untouched save keeps it', () => {
    const { saved } = editor({ ...BASE, workAuth: 'yes' })
    expect(chosen()).toEqual([])
    expect(hint('workAuth')).toContain('yes')
    expect('workAuth' in saved()[1]).toBe(false)
  })

  it('offers no sponsorship entry, and never sends one', () => {
    const { saved } = editor({ ...BASE, workAuth: '["de"]', sponsorshipNeeded: 'no' })
    expect(screen.queryByLabelText('Needs sponsorship')).toBeNull()
    expect(screen.queryByText(/sponsorship/i)).toBeNull()
    expect('sponsorshipNeeded' in saved()[1]).toBe(false)
  })
})

describe('the list editor against the host', () => {
  const host = installHeldMappingHost()
  let calls: { method: string; params: unknown }[]

  beforeEach(() => {
    host.nothingPending = true
    calls = []
    const bridge = window.__jffHostBridge!
    window.__jffHostBridge = async (req): Promise<HostResponse> => {
      calls.push({ method: req.method, params: req.params })
      if (req.method === 'answerBank.get') return { requestId: req.requestId, ok: true, result: { workAuth: 'yes' } }
      if (req.method === 'answerBank.set') {
        return { requestId: req.requestId, ok: true, result: (req.params as { values: Record<string, string> }).values }
      }
      return bridge(req)
    }
  })

  it('an old bare yes shows as a hint, and the countries chosen reach the host as the list', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit your facts' }))
    await waitFor(() => { expect((screen.getByRole('button', { name: 'Save facts' }) as HTMLButtonElement).disabled).toBe(false) })
    expect(hint('workAuth')).toContain('yes')
    add('Portugal')
    add('Germany')
    fireEvent.click(screen.getByRole('button', { name: 'Save facts' }))
    await waitFor(() => { expect(calls.some((c) => c.method === 'answerBank.set')).toBe(true) })
    const set = calls.find((c) => c.method === 'answerBank.set')!.params as { values: Record<string, string> }
    expect(set.values.workAuth).toBe('["de","pt"]')
    expect('sponsorshipNeeded' in set.values).toBe(false)
  })
})
