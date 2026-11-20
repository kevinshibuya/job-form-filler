import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FoundAddress } from '@jff/shared'
import { App } from './App'
import type { Session } from './sessions'
import { field, installHeldMappingHost, status, type AppliedCheckJob, type AppliedCheckParams } from './testing/heldMapping'

/**
 * The Revisit badge by Apply address in the Side panel (spec #66, ticket
 * #76). Before the Apply address pick runs, the panel asks the Native host
 * with every candidate on the page; a typed address or one picked from the
 * list is asked about before its Draft starts. A hit shows the badge with the
 * Applied job's Company, title and date, and the pick and the Draft wait for
 * "Draft anyway". The badge by Canonical URL is unchanged and wins. The App
 * renders against a fake Native host.
 */

const host = installHeldMappingHost()

const PAGE: FoundAddress[] = [
  { address: 'privacy@example.org', context: { kind: 'text', sentence: 'For privacy questions write to privacy@example.org.' } },
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
]
const JOB_TEXT = 'Acme is hiring an analyst to build analytical engines. '.repeat(10).trim()
const URL_OF_TAB = 'https://careers.example.com/jobs/1'

/** The Applied job jobs@example.org was mailed for, reached through another Canonical URL. */
const MAILED: AppliedCheckJob = {
  id: 4, url: 'https://board.example.net/postings/77', canonicalUrl: 'board.example.net/postings/77',
  company: 'Acme', jobTitle: 'Senior Analyst', markedAt: '2026-07-01T12:00:00.000Z', channel: 'email',
}
const MAILED_ON = new Date(MAILED.markedAt).toLocaleDateString()

function onCareersTab(): void {
  const tab = { id: 7, url: URL_OF_TAB, title: 'Analyst at Acme' }
  const chrome = (globalThis as unknown as { chrome: { tabs: { query: unknown; get: unknown } } }).chrome
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
}

/** The Native host knows jobs@example.org, in any case, as MAILED's Apply address. */
const knowsJobsAddress = (p: AppliedCheckParams): { applied: null; appliedByAddress: AppliedCheckJob | null } => ({
  applied: null,
  appliedByAddress: (p.applyAddresses ?? []).some((a) => a.toLowerCase() === 'jobs@example.org') ? MAILED : null,
})

const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined
const badge = (): HTMLElement | null => document.querySelector('[data-jff-revisit-address]')
const urlBadge = (): HTMLElement | null => document.querySelector('[data-jff-applied]')
const count = (method: string): number => host.methods.filter((m) => m === method).length
const typedInput = (): HTMLInputElement => document.querySelector('[data-jff-email-typed] input') as HTMLInputElement
const draftAnyway = (): void => { fireEvent.click(within(badge()!).getByRole('button', { name: 'Draft anyway' })) }

async function scanEmailPage(): Promise<void> {
  onCareersTab()
  host.addresses = PAGE
  host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
  render(<App />)
  await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
}

function typeAddress(value: string): void {
  fireEvent.change(typedInput(), { target: { value } })
  fireEvent.click(within(document.querySelector('[data-jff-email-typed]') as HTMLElement).getByRole('button', { name: 'Use this address' }))
}

describe('a page whose candidates hold an address already mailed', () => {
  it('asks with every candidate, and shows the badge with the Company, title and date before any pick or Draft', async () => {
    host.appliedCheck = knowsJobsAddress
    await scanEmailPage()
    await waitFor(() => { expect(badge()).not.toBeNull() })
    const text = badge()!.textContent ?? ''
    expect(text).toContain('Senior Analyst')
    expect(text).toContain('Acme')
    expect(text).toContain(MAILED_ON)
    expect(host.appliedChecks.at(-1)).toEqual({ url: URL_OF_TAB, applyAddresses: ['privacy@example.org', 'jobs@example.org'] })
    expect(count('applyAddress.pick')).toBe(0)
    expect(count('email.draft')).toBe(0)
    expect(sessionRow()?.revisitPassed).toBe(false)
    expect(urlBadge()).toBeNull()
  }, 15_000)

  it('"Draft anyway" starts the pick, which starts the Draft, and sets revisitPassed', async () => {
    host.appliedCheck = knowsJobsAddress
    host.addressPick = (p) => ({ position: p.candidates.findIndex((c) => c.address === 'jobs@example.org') })
    await scanEmailPage()
    await waitFor(() => { expect(badge()).not.toBeNull() })
    draftAnyway()
    await waitFor(() => { expect(host.addressPicks).toHaveLength(1) })
    await waitFor(() => { expect(host.emailDrafts).toHaveLength(1) })
    await waitFor(() => { expect(sessionRow()?.revisitPassed).toBe(true) })
    expect(sessionRow()?.applyAddress).toBe('jobs@example.org')
    expect(sessionRow()?.addressRevisit ?? null).toBeNull()
    expect(badge()).toBeNull()
  }, 15_000)

  it('keeps the badge in the Session, so a reopened panel shows it', async () => {
    host.appliedCheck = knowsJobsAddress
    onCareersTab()
    host.addresses = PAGE
    const first = render(<App />)
    await waitFor(() => { expect(badge()).not.toBeNull() }, { timeout: 8_000 })
    await waitFor(() => { expect(sessionRow()?.addressRevisit?.waiting).toEqual({ kind: 'pick' }) })
    first.unmount()
    render(<App />)
    await waitFor(() => { expect(badge()).not.toBeNull() }, { timeout: 8_000 })
    expect(count('applyAddress.pick')).toBe(0)
  }, 20_000)

  it('proceeds to the pick when the check fails', async () => {
    host.appliedCheck = (p) => (p.applyAddresses === undefined
      ? { applied: null, appliedByAddress: null }
      : { error: { kind: 'db', message: 'database is locked' } })
    await scanEmailPage()
    await waitFor(() => { expect(host.addressPicks).toHaveLength(1) })
    expect(badge()).toBeNull()
  }, 15_000)

  it('sends the pick as before when no candidate was mailed', async () => {
    await scanEmailPage()
    await waitFor(() => { expect(host.addressPicks).toHaveLength(1) })
    expect(host.appliedChecks.some((c) => c.applyAddresses !== undefined)).toBe(true)
    expect(badge()).toBeNull()
  }, 15_000)
})

describe('"Apply by email instead" beside a form', () => {
  it('asks with the candidates on the click, and a hit holds the pick', async () => {
    onCareersTab()
    host.fields = [field(0, 'Email'), field(1, 'Why us?')]
    host.nothingPending = true
    host.addresses = PAGE
    host.appliedCheck = knowsJobsAddress
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    await waitFor(() => { expect(sessionRow()).toBeDefined() })
    // The Scan asked as it does today, by Canonical URL alone.
    expect(host.appliedChecks).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Apply by email instead' }))
    await waitFor(() => { expect(badge()).not.toBeNull() })
    expect(host.appliedChecks.at(-1)?.applyAddresses).toEqual(['privacy@example.org', 'jobs@example.org'])
    expect(count('applyAddress.pick')).toBe(0)
  }, 15_000)
})

describe('an address the user chose', () => {
  it('shows the badge for a typed address already mailed before its Draft starts, and "Draft anyway" drafts it', async () => {
    onCareersTab()
    host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
    host.appliedCheck = knowsJobsAddress
    render(<App />)
    await waitFor(() => { expect(status()).toBe('empty') }, { timeout: 8_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Type an Apply address' }))
    typeAddress('Jobs@Example.org')
    await waitFor(() => { expect(badge()).not.toBeNull() })
    expect(host.appliedChecks.at(-1)?.applyAddresses).toEqual(['Jobs@Example.org'])
    expect(count('email.draft')).toBe(0)
    expect(sessionRow()?.applyAddress ?? null).toBeNull()
    draftAnyway()
    await waitFor(() => { expect(host.emailDrafts).toHaveLength(1) })
    await waitFor(() => { expect(sessionRow()?.applyAddress).toBe('Jobs@Example.org') })
    expect(sessionRow()?.applyAddressChosenBy).toBe('typed')
    expect(sessionRow()?.revisitPassed).toBe(true)
  }, 15_000)

  it('checks one picked from the list the same way', async () => {
    host.appliedCheck = (p) => ({
      applied: null,
      // The candidates as a whole hold nothing mailed; the list pick is asked alone.
      appliedByAddress: p.applyAddresses?.length === 1 && p.applyAddresses[0] === 'privacy@example.org' ? MAILED : null,
    })
    await scanEmailPage()
    await waitFor(() => { expect(document.querySelector('[data-jff-email-pick="none"]')).not.toBeNull() })
    fireEvent.click(within(document.querySelector('[data-jff-candidate="privacy@example.org"]') as HTMLElement).getByRole('button', { name: 'Use this address' }))
    await waitFor(() => { expect(badge()).not.toBeNull() })
    expect(count('email.draft')).toBe(0)
    await waitFor(() => { expect(sessionRow()?.addressRevisit?.waiting).toEqual({ kind: 'choose', address: 'privacy@example.org', how: 'list' }) })
  }, 15_000)
})

describe('the badge by Canonical URL', () => {
  it('wins on a page that is itself an Applied job: no address badge, and no check with addresses', async () => {
    onCareersTab()
    host.addresses = PAGE
    host.appliedCheck = (p) => ({ applied: { ...MAILED, url: URL_OF_TAB }, appliedByAddress: p.applyAddresses === undefined ? null : MAILED })
    render(<App />)
    await waitFor(() => { expect(urlBadge()).not.toBeNull() }, { timeout: 8_000 })
    expect(badge()).toBeNull()
    expect(host.appliedChecks.every((c) => c.applyAddresses === undefined)).toBe(true)
    expect(count('applyAddress.pick')).toBe(0)
  }, 15_000)

  it('"Scan anyway" sets revisitPassed, and it is still set after a Side panel reload', async () => {
    onCareersTab()
    host.appliedCheck = () => ({ applied: { ...MAILED, url: URL_OF_TAB }, appliedByAddress: null })
    const first = render(<App />)
    await waitFor(() => { expect(urlBadge()).not.toBeNull() }, { timeout: 8_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Scan anyway' }))
    await waitFor(() => { expect(sessionRow()?.revisitPassed).toBe(true) })
    await waitFor(() => { expect(status()).toBe('empty') }, { timeout: 8_000 })
    first.unmount()
    render(<App />)
    await waitFor(() => { expect(urlBadge()).not.toBeNull() }, { timeout: 8_000 })
    expect(sessionRow()?.revisitPassed).toBe(true)
  }, 20_000)

  it('a Scan of a page with no candidates sends the check as it does today', async () => {
    onCareersTab()
    render(<App />)
    await waitFor(() => { expect(status()).toBe('empty') }, { timeout: 8_000 })
    expect(host.appliedChecks).toHaveLength(1)
    expect(Object.keys(host.appliedChecks[0]!)).toEqual(['url'])
    expect(host.appliedChecks[0]!.url).toBe(URL_OF_TAB)
  }, 15_000)
})
