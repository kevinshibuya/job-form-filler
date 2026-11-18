import { describe, it, expect, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { App } from './App'
import { installHeldMappingHost, status, statusText } from './testing/heldMapping'

/**
 * The empty state on an ATS posting (spec #41): a zero-Field Scan shows the
 * empty state's own sentence, then the hint of the page's ATS, which says
 * where its form is. A page with no known ATS shows the empty state as before.
 * The App renders against a fake Native host and a page with no Fields.
 */

const EMPTY = '⚠ Scanned 1 frames, found no form fields. Open the application form, then Scan again.'
const ASHBY_HINT = 'On Ashby the form is under the "Application" tab. Open it, then Scan again.'
const LEVER_HINT = 'On Lever the form opens from "Apply for this job". Open it, then Scan again.'

const host = installHeldMappingHost()

/** The tab the panel scans, on the given address. */
function onTab(url: string): void {
  const tab = { id: 7, url, title: 'Engineer' }
  const chrome = (globalThis as unknown as { chrome: { tabs: { query: unknown; get: unknown } } }).chrome
  chrome.tabs.query = async () => [tab]
  chrome.tabs.get = async () => tab
}

beforeEach(() => {
  host.fields = []
})

/** Mount and wait for the auto-Scan to settle empty, past its one 1.5s retry. */
async function emptyScan(): Promise<string> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe('empty') }, { timeout: 8_000 })
  return statusText()
}

describe('the empty state says where the form is on an ATS', () => {
  it('on an Ashby hostname it is followed by Ashby\'s hint', async () => {
    onTab('https://jobs.ashbyhq.com/acme/123')
    const text = await emptyScan()
    expect(text).toContain(`${EMPTY} ${ASHBY_HINT}`)
    expect(text).not.toContain(LEVER_HINT)
  }, 15_000)

  it('on a Lever hostname it is followed by Lever\'s', async () => {
    onTab('https://jobs.lever.co/acme/123')
    const text = await emptyScan()
    expect(text).toContain(`${EMPTY} ${LEVER_HINT}`)
    expect(text).not.toContain(ASHBY_HINT)
  }, 15_000)

  it('on an unknown site it shows neither', async () => {
    onTab('https://careers.example.com/jobs/123')
    const text = await emptyScan()
    expect(text).toContain(EMPTY)
    expect(text).not.toContain(ASHBY_HINT)
    expect(text).not.toContain(LEVER_HINT)
  }, 15_000)
})
