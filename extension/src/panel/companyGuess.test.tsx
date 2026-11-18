import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import type { Session } from './sessions'
import { field, installHeldMappingHost, status } from './testing/heldMapping'

/**
 * The Company in the Side panel (spec #41): the Scan guesses it from the ATS's
 * title and address once the elected frame is known, the panel shows it and
 * the Session marks it as a guess, and a Company the user typed survives the
 * next Scan, whose requests carry it. The App renders against a fake Native
 * host.
 */

const host = installHeldMappingHost()

const LEVER = 'https://jobs.lever.co/acme-rockets/123/apply'

/** The tab the panel scans, and the frame its form sits in. */
function onPage(url: string, title: string, frameUrl = url): void {
  const tab = { id: 7, url, title }
  const chrome = (globalThis as unknown as { chrome: { tabs: { query: unknown; get: unknown } } }).chrome
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
  host.frameUrl = frameUrl
  host.fields = [field(0, 'Email'), field(1, 'Why us?')]
  host.nothingPending = true
}

const companyInput = (): HTMLInputElement => document.querySelector('[data-jff-company] input') as HTMLInputElement
const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined

describe('the Company guessed on a Scan', () => {
  it('shows the Company read from a Lever address, marks it as a guess, and the first request carries it', async () => {
    onPage(LEVER, 'Apply')
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    await waitFor(() => { expect(companyInput().value).toBe('Acme Rockets') })
    await waitFor(() => { expect(sessionRow()?.companyGuessed).toBe(true) })
    expect(host.firstCompanies).toEqual(['Acme Rockets'])
  })

  it('reads a Greenhouse frame\'s address on a company\'s page', async () => {
    onPage('https://www.acme.com/careers/1', 'Careers', 'https://boards.greenhouse.io/embed/job_app?for=acme-rockets&token=1')
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    await waitFor(() => { expect(companyInput().value).toBe('Acme Rockets') })
    expect(host.firstCompanies).toEqual(['Acme Rockets'])
  })

  it('keeps a Company the user typed through a second Scan, whose request carries it', async () => {
    onPage(LEVER, 'Acme Rockets - Senior Engineer')
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    await waitFor(() => { expect(companyInput().value).toBe('Acme Rockets') })
    fireEvent.change(companyInput(), { target: { value: 'Initech' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Scan' }))
    await waitFor(() => { expect(host.firstCompanies).toHaveLength(2) })
    await waitFor(() => { expect(status()).toBe('done') })
    expect(host.firstCompanies[1]).toBe('Initech')
    expect(companyInput().value).toBe('Initech')
    await waitFor(() => { expect(sessionRow()?.company).toBe('Initech') })
    expect(sessionRow()?.companyGuessed).toBe(false)
  })

  it('offers no ATS\'s name as the Company', async () => {
    onPage('https://jobs.lever.co/lever/123/apply', 'Apply')
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    expect(companyInput().value).toBe('')
    expect(host.firstCompanies).toEqual([null])
  })
})
