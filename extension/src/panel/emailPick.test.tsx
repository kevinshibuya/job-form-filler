import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ApplyAddressPickParams, FoundAddress } from '@jff/shared'
import { App } from './App'
import type { Session } from './sessions'
import { field, installHeldMappingHost, status } from './testing/heldMapping'

/**
 * The Apply address pick in the Side panel (spec #66, ticket #71). A Scan
 * with no Field and at least one candidate asks the Native host to pick
 * without a click; beside a form it asks only after "Apply by email instead".
 * A pick becomes the Session's Apply address, recorded as `pick`. None, a
 * position outside the list and a failure all end at the candidate list with
 * the box to type an address. The App renders against a fake Native host.
 */

const host = installHeldMappingHost()

const PAGE: FoundAddress[] = [
  { address: 'privacy@example.org', context: { kind: 'text', sentence: 'For privacy questions write to privacy@example.org.' } },
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
]
const JOB_TEXT = 'Acme is hiring an analyst to build analytical engines. '.repeat(10).trim()

function onCareersTab(): void {
  const tab = { id: 7, url: 'https://careers.example.com/jobs/1', title: 'Analyst at Acme' }
  const chrome = (globalThis as unknown as { chrome: { tabs: { query: unknown; get: unknown } } }).chrome
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
}

const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined
const candidates = (): string[] =>
  [...document.querySelectorAll('[data-jff-candidate]')].map((li) => li.getAttribute('data-jff-candidate') ?? '')
const toInput = (): HTMLInputElement | null => document.querySelector('[data-jff-email-to] input')
const typedInput = (): HTMLInputElement | null => document.querySelector('[data-jff-email-typed] input')
const pickState = (): string | null => document.querySelector('[data-jff-email-pick]')?.getAttribute('data-jff-email-pick') ?? null
const pickRequests = (): number => host.methods.filter((m) => m === 'applyAddress.pick').length

/** A pick the test answers by hand, to look at the panel while it is out. */
function heldPick(): { answer: (a: { position: number | null }) => void } {
  let answer: (a: { position: number | null }) => void = () => {}
  host.addressPick = () => new Promise((resolve) => { answer = resolve })
  return { answer: (a) => answer(a) }
}

async function scanEmailPage(): Promise<void> {
  onCareersTab()
  host.addresses = PAGE
  host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
  render(<App />)
  await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
}

/** The pick ended without an address: the candidates, the box, and no Apply address. */
async function endsAtTheCandidateList(state: 'none' | 'failed'): Promise<void> {
  await waitFor(() => { expect(pickState()).toBe(state) })
  expect(candidates()).toEqual(['privacy@example.org', 'jobs@example.org'])
  expect(typedInput()).not.toBeNull()
  expect(toInput()).toBeNull()
  expect(sessionRow()?.applyAddress ?? null).toBeNull()
}

describe('a page with no Fields and addresses on it', () => {
  it('sends the pick without a click, with the candidates, the title, the Company and the start of the Job posting text', async () => {
    await scanEmailPage()
    await waitFor(() => { expect(host.addressPicks).toHaveLength(1) })
    const sent: ApplyAddressPickParams = host.addressPicks[0]!
    expect(sent.candidates).toEqual([
      { address: 'privacy@example.org', contexts: [PAGE[0]!.context] },
      { address: 'jobs@example.org', contexts: [PAGE[1]!.context] },
    ])
    expect(sent.title).toBe('Analyst at Acme')
    expect(sent.company).toBe('Acme')
    expect(sent.jobText).toBe(JOB_TEXT)
  }, 15_000)

  it('makes the picked candidate the Apply address, recorded as pick', async () => {
    host.addressPick = (p) => ({ position: p.candidates.findIndex((c) => c.address === 'jobs@example.org') })
    await scanEmailPage()
    await waitFor(() => { expect(toInput()?.value).toBe('jobs@example.org') })
    expect(document.querySelector('[data-jff-email-chosen]')?.getAttribute('data-jff-email-chosen')).toBe('pick')
    await waitFor(() => { expect(sessionRow()?.applyAddress).toBe('jobs@example.org') })
    expect(sessionRow()?.applyAddressChosenBy).toBe('pick')
    expect(pickRequests()).toBe(1)
  }, 15_000)

  it('says it is choosing while the pick is out', async () => {
    const held = heldPick()
    await scanEmailPage()
    await waitFor(() => { expect(pickState()).toBe('picking') })
    held.answer({ position: 1 })
    await waitFor(() => { expect(sessionRow()?.applyAddressChosenBy).toBe('pick') })
    expect(pickState()).toBeNull()
  }, 15_000)

  it('ends at the candidate list with the box when the model picks none', async () => {
    await scanEmailPage()
    await endsAtTheCandidateList('none')
  }, 15_000)

  it('refuses a position outside the list and ends at the candidate list', async () => {
    host.addressPick = () => ({ position: 2 })
    await scanEmailPage()
    await endsAtTheCandidateList('none')
  }, 15_000)

  it('ends at the candidate list with the box when the Task fails, and says why', async () => {
    host.addressPick = () => ({ error: { kind: 'timeout', message: 'codex timed out' } })
    await scanEmailPage()
    await endsAtTheCandidateList('failed')
    expect(document.querySelector('[data-jff-email-pick]')?.textContent).toContain('codex timed out')
  }, 15_000)

  it('keeps the address the user chose while the pick was out', async () => {
    const held = heldPick()
    await scanEmailPage()
    await waitFor(() => { expect(pickState()).toBe('picking') })
    fireEvent.click(within(document.querySelector('[data-jff-candidate="privacy@example.org"]') as HTMLElement).getByRole('button', { name: 'Use this address' }))
    await waitFor(() => { expect(sessionRow()?.applyAddressChosenBy).toBe('list') })
    held.answer({ position: 1 })
    await waitFor(() => { expect(pickState()).toBeNull() })
    expect(sessionRow()?.applyAddress).toBe('privacy@example.org')
    expect(sessionRow()?.applyAddressChosenBy).toBe('list')
    expect(toInput()?.value).toBe('privacy@example.org')
  }, 15_000)
})

describe('a page with no Fields and no address', () => {
  it('sends no pick', async () => {
    onCareersTab()
    render(<App />)
    await waitFor(() => { expect(status()).toBe('empty') }, { timeout: 8_000 })
    expect(pickRequests()).toBe(0)
  }, 15_000)
})

describe('a page with Fields and an address', () => {
  it('sends no pick until "Apply by email instead" is clicked, then picks', async () => {
    onCareersTab()
    host.fields = [field(0, 'Email'), field(1, 'Why us?')]
    host.nothingPending = true
    host.addresses = PAGE
    host.addressPick = () => ({ position: 1 })
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    await waitFor(() => { expect(sessionRow()).toBeDefined() })
    expect(pickRequests()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Apply by email instead' }))
    await waitFor(() => { expect(sessionRow()?.applyAddress).toBe('jobs@example.org') })
    expect(sessionRow()?.applyAddressChosenBy).toBe('pick')
    expect(pickRequests()).toBe(1)
    expect(host.addressPicks[0]!.candidates.map((c) => c.address)).toEqual(['privacy@example.org', 'jobs@example.org'])
  }, 15_000)

  it('ends at the candidate list with the box when the pick after the click fails', async () => {
    onCareersTab()
    host.fields = [field(0, 'Email')]
    host.nothingPending = true
    host.addresses = PAGE
    host.addressPick = () => ({ error: { kind: 'process', message: 'codex exited 1' } })
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    fireEvent.click(screen.getByRole('button', { name: 'Apply by email instead' }))
    await endsAtTheCandidateList('failed')
  }, 15_000)
})
