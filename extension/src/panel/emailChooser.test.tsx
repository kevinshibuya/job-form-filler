import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FoundAddress } from '@jff/shared'
import { App } from './App'
import type { Session } from './sessions'
import { field, installHeldMappingHost, status, statusText } from './testing/heldMapping'

/**
 * Choosing the Apply address in the Side panel (spec #66). A Scan's reply
 * carries the page's addresses; the panel lists them as candidates on a page
 * with no Fields, offers them quietly beside a form, and takes an address the
 * user types under a shape check. The App renders against a fake Native host
 * whose page reports the addresses each test sets.
 */

const host = installHeldMappingHost()

/** The careers-page fixture's addresses, as its page script reports them. */
const CAREERS: FoundAddress[] = [
  { address: 'address-1@example.org', context: { kind: 'mailto', linkText: 'Mail je sollicitatie', subject: 'Sollicitatie: Senior full-stack developer' } },
  { address: 'address-1@example.org', context: { kind: 'text', sentence: 'Placeholder text address-1@example.org Placeholder text.' } },
  { address: 'address-2@example.org', context: { kind: 'mailto', linkText: 'address-2@example.org', subject: null } },
]
const JOB_TEXT = 'Placeholder text where the Job posting described the role. '.repeat(10).trim()
const EMPTY = '⚠ Scanned 1 frames, found no form fields. Open the application form, then Scan again.'
/** What the panel asks the Native host before any Scan, and the applied check every Scan makes first. */
const BEFORE_SCAN = new Set(['selfCheck', 'profile.get', 'answerBank.get', 'applied.check'])

function onCareersTab(): void {
  const tab = { id: 7, url: 'https://careers.example.com/vacatures/1', title: 'Apply by email at Acme' }
  const chrome = (globalThis as unknown as { chrome: { tabs: { query: unknown; get: unknown } } }).chrome
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
}

const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined
const candidates = (): string[] =>
  [...document.querySelectorAll('[data-jff-candidate]')].map((li) => li.getAttribute('data-jff-candidate') ?? '')
const candidateRow = (address: string): HTMLElement =>
  document.querySelector(`[data-jff-candidate="${address}"]`) as HTMLElement
const toInput = (): HTMLInputElement | null => document.querySelector('[data-jff-email-to] input')
const typedInput = (): HTMLInputElement => document.querySelector('[data-jff-email-typed] input') as HTMLInputElement
const hostRequests = (): string[] => host.methods.filter((m) => !BEFORE_SCAN.has(m))
const pickButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Pick job description' }) as HTMLButtonElement

async function scanWithNoFields(expected: 'email' | 'empty'): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe(expected) }, { timeout: 8_000 })
}

function typeAddress(value: string): void {
  fireEvent.change(typedInput(), { target: { value } })
  fireEvent.click(within(document.querySelector('[data-jff-email-typed]') as HTMLElement).getByRole('button', { name: 'Use this address' }))
}

describe('a page with no Fields and addresses on it', () => {
  it('lists the candidates with their contexts, and the Session holds the Job posting text and a Company', async () => {
    onCareersTab()
    host.addresses = CAREERS
    host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
    await scanWithNoFields('email')
    expect(statusText()).not.toContain('Open the application form')
    expect(candidates()).toEqual(['address-1@example.org', 'address-2@example.org'])
    const first = candidateRow('address-1@example.org').textContent ?? ''
    expect(first).toContain('Mail je sollicitatie')
    expect(first).toContain('Sollicitatie: Senior full-stack developer')
    expect(first).toContain('Placeholder text address-1@example.org Placeholder text.')
    expect(typedInput()).not.toBeNull()
    await waitFor(() => { expect(sessionRow()?.applyCandidates).toHaveLength(2) })
    expect(sessionRow()?.jobText).toBe(JOB_TEXT)
    expect(sessionRow()?.jobTextSource).toBe('heuristic')
    expect(sessionRow()?.company).toBe('Acme')
    // The Apply address pick runs without a click on a page with no Field (#71).
    await waitFor(() => { expect(hostRequests()).toEqual(['selector.get', 'applyAddress.pick']) })
  }, 15_000)

  it('lists an address found in a frame other than the top one', async () => {
    onCareersTab()
    host.otherFrames = [{ frameId: 3, url: 'https://embed.example.net/job', addresses: [{ address: 'framed@example.org', context: { kind: 'text', sentence: 'Apply at framed@example.org.' } }] }]
    await scanWithNoFields('email')
    expect(candidates()).toEqual(['framed@example.org'])
  }, 15_000)

  it('never lists the user\'s own email address', async () => {
    onCareersTab()
    host.addresses = [{ address: 'Ada@Example.com', context: { kind: 'text', sentence: 'Signed in as Ada@Example.com.' } }, CAREERS[0]!]
    await scanWithNoFields('email')
    expect(candidates()).toEqual(['address-1@example.org'])
  }, 15_000)

  it('makes the picked candidate the Apply address, recorded as list', async () => {
    onCareersTab()
    host.addresses = CAREERS
    await scanWithNoFields('email')
    fireEvent.click(within(candidateRow('address-2@example.org')).getByRole('button', { name: 'Use this address' }))
    await waitFor(() => { expect(toInput()?.value).toBe('address-2@example.org') })
    await waitFor(() => { expect(sessionRow()?.applyAddress).toBe('address-2@example.org') })
    expect(sessionRow()?.applyAddressChosenBy).toBe('list')
  }, 15_000)

  it('lets the paste box and "Pick job description" set the Job posting text', async () => {
    onCareersTab()
    host.addresses = CAREERS
    host.pickText = JOB_TEXT
    await scanWithNoFields('email')
    await waitFor(() => { expect(pickButton().disabled).toBe(false) })
    fireEvent.click(pickButton())
    await waitFor(() => { expect(sessionRow()?.jobTextSource).toBe('pick') })
    expect(sessionRow()?.jobText).toBe(JOB_TEXT)
    const paste = document.querySelector('[data-jff-paste] textarea') as HTMLTextAreaElement
    expect(paste.disabled).toBe(false)
    fireEvent.change(paste, { target: { value: 'The posting, pasted by hand.' } })
    await waitFor(() => { expect(sessionRow()?.jobTextSource).toBe('paste') })
    expect(sessionRow()?.jobText).toBe('The posting, pasted by hand.')
  }, 15_000)

  it('keeps the candidates, the Apply address and how it was chosen through a panel reload', async () => {
    onCareersTab()
    host.addresses = CAREERS
    const first = render(<App />)
    await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
    fireEvent.click(within(candidateRow('address-2@example.org')).getByRole('button', { name: 'Use this address' }))
    await waitFor(() => { expect(sessionRow()?.applyAddressChosenBy).toBe('list') })
    first.unmount()
    // The reopened panel's own Scan never reaches the page, so what shows is the stored Session.
    host.holdScan = true
    render(<App />)
    await waitFor(() => { expect(toInput()?.value).toBe('address-2@example.org') })
    expect(document.querySelector('[data-jff-email-chosen]')?.getAttribute('data-jff-email-chosen')).toBe('list')
    expect(candidates()).toEqual(['address-1@example.org', 'address-2@example.org'])
  }, 15_000)
})

describe('a page with no Fields and no address', () => {
  it('keeps today\'s sentence, adds an action to type an address, and sends the Native host nothing', async () => {
    onCareersTab()
    await scanWithNoFields('empty')
    expect(statusText()).toContain(EMPTY)
    expect(candidates()).toEqual([])
    expect(pickButton().disabled).toBe(true)
    expect(hostRequests()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Type an Apply address' }))
    expect(typedInput()).not.toBeNull()
    expect(hostRequests()).toEqual([])
  }, 15_000)

  it('refuses a typed address of the wrong shape with a message, and takes a good one as typed', async () => {
    onCareersTab()
    host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
    await scanWithNoFields('empty')
    fireEvent.click(screen.getByRole('button', { name: 'Type an Apply address' }))
    typeAddress('jobs at example dot org')
    expect(document.querySelector('[data-jff-email-error]')?.textContent).toMatch(/not an email address/i)
    expect(toInput()).toBeNull()
    typeAddress('  jobs@example.org ')
    await waitFor(() => { expect(toInput()?.value).toBe('jobs@example.org') })
    expect(document.querySelector('[data-jff-email-error]')).toBeNull()
    await waitFor(() => { expect(sessionRow()?.applyAddress).toBe('jobs@example.org') })
    expect(sessionRow()?.applyAddressChosenBy).toBe('typed')
    // The text is read once there is an address to write to.
    await waitFor(() => { expect(sessionRow()?.jobText).toBe(JOB_TEXT) })
    // Then the Application email's one Draft starts (ticket #72).
    await waitFor(() => { expect(hostRequests()).toEqual(['selector.get', 'email.draft']) })
    // The paste box and the pick work now that the Session holds an Apply address.
    expect(pickButton().disabled).toBe(false)
  }, 15_000)

  it('keeps the To row editable under the same shape check', async () => {
    onCareersTab()
    await scanWithNoFields('empty')
    fireEvent.click(screen.getByRole('button', { name: 'Type an Apply address' }))
    typeAddress('jobs@example.org')
    await waitFor(() => { expect(toInput()).not.toBeNull() })
    fireEvent.change(toInput()!, { target: { value: 'jobs@' } })
    fireEvent.blur(toInput()!)
    expect(document.querySelector('[data-jff-email-error]')?.textContent).toMatch(/not an email address/i)
    await waitFor(() => { expect(sessionRow()?.applyAddress).toBe('jobs@example.org') })
    fireEvent.change(toInput()!, { target: { value: 'careers@example.org' } })
    fireEvent.blur(toInput()!)
    await waitFor(() => { expect(sessionRow()?.applyAddress).toBe('careers@example.org') })
    expect(sessionRow()?.applyAddressChosenBy).toBe('typed')
    expect(document.querySelector('[data-jff-email-error]')).toBeNull()
  }, 15_000)
})

describe('a page with Fields and an address', () => {
  /** Mount on a form page, wait for its Scan to settle, and give back the requests it sent, sorted. */
  async function formScan(addresses: FoundAddress[]): Promise<{ unmount: () => void; requests: string[] }> {
    for (const k of Object.keys(host.storage)) delete host.storage[k]
    host.methods.length = 0
    host.addresses = addresses
    const view = render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    await waitFor(() => { expect(host.storage['jff:session:7']).toBeDefined() })
    return { unmount: view.unmount, requests: [...host.methods].sort() }
  }

  it('offers "Apply by email instead" quietly, and the Scan sends the same requests as without the address', async () => {
    host.fields = [field(0, 'Email'), field(1, 'Why us?')]
    host.nothingPending = true
    const without = await formScan([])
    expect(document.querySelector('[data-jff-email-offer]')).toBeNull()
    without.unmount()
    const withAddress = await formScan(CAREERS)
    expect(withAddress.requests).toEqual(without.requests)
    const offer = screen.getByRole('button', { name: 'Apply by email instead' })
    expect(candidates()).toEqual([])
    const before = host.methods.length
    fireEvent.click(offer)
    expect(candidates()).toEqual(['address-1@example.org', 'address-2@example.org'])
    expect(typedInput()).not.toBeNull()
    // The click is what sends the Apply address pick, and nothing else (#71).
    await waitFor(() => { expect(host.methods.slice(before)).toEqual(['applyAddress.pick']) })
  })
})
