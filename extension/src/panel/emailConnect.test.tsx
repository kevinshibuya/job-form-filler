import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import type { FoundAddress, MailStatus } from '@jff/shared'
import { App } from './App'
import { installHeldMappingHost, status } from './testing/heldMapping'

/**
 * Connect from the Side panel (spec #66, ticket #80), at the panel seam: the
 * whole App against a fake Native host. The email Review asks `mail.status`
 * when it opens. With no Mail account, Connect sits beside "Open in my mail
 * app" and opens the settings page, or focuses it when it is open. The Draft
 * is written whether or not a Mail account exists.
 */

const host = installHeldMappingHost()

const EXT = 'chrome-extension://jffextensionid/'
const SETTINGS = `${EXT}src/settings/index.html`
const PAGE: FoundAddress[] = [
  { address: 'jobs@example.org', context: { kind: 'mailto', linkText: 'Apply by email', subject: 'Application: Analyst' } },
]
const JOB_TEXT = 'Acme is hiring an analyst to build analytical engines. '.repeat(10).trim()
const CONNECTED: MailStatus = { state: 'connected', kind: 'gmail', address: 'ada@example.com', connectedAt: '2026-11-19T12:00:00.000Z' }

interface FakeTab { id: number; url: string; title: string; active: boolean; windowId: number }
let tabs: FakeTab[]
let created: string[]
let focusedTabs: number[]

beforeEach(() => {
  const job: FakeTab = { id: 7, url: 'https://careers.example.com/jobs/1', title: 'Analyst at Acme', active: true, windowId: 1 }
  tabs = [job]
  created = []
  focusedTabs = []
  const chrome = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome
  chrome.runtime!.getURL = (path: string) => `${EXT}${path.replace(/^\//, '')}`
  chrome.tabs!.query = async (q: { active?: boolean } = {}) => tabs.filter((t) => q.active !== true || t.active)
  chrome.tabs!.get = async (id: number) => tabs.find((t) => t.id === id)
  chrome.tabs!.create = async ({ url }: { url: string }) => {
    created.push(url)
    const tab: FakeTab = { id: 100 + created.length, url, title: 'Settings', active: false, windowId: 1 }
    tabs.push(tab)
    return tab
  }
  chrome.tabs!.update = async (id: number, props: { active?: boolean }) => {
    if (props.active === true) focusedTabs.push(id)
    return tabs.find((t) => t.id === id)
  }
  chrome.windows!.update = async (id: number) => ({ id })
  host.addresses = PAGE
  host.jobText = { text: JOB_TEXT, selector: null, source: 'heuristic' }
  host.addressPick = () => ({ position: 0 })
})

const sendRow = (): HTMLElement | null => document.querySelector('[data-jff-email-send]')
const connectButton = (): HTMLElement | null => sendRow() === null ? null : within(sendRow()!).queryByRole('button', { name: 'Connect' })
const mailAppAction = (): HTMLElement | null => document.querySelector('[data-jff-email-mailapp]')
const bodyInput = (): HTMLTextAreaElement | null => document.querySelector('[data-jff-email-body] textarea')

/** The page is scanned, the pick chooses jobs@example.org and the Draft is shown. */
async function draftShown(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe('email') }, { timeout: 8_000 })
  await waitFor(() => { expect(bodyInput()).not.toBeNull() }, { timeout: 8_000 })
}

describe('the email Review asks mail.status when it opens', () => {
  it('asks once the Review is shown', async () => {
    await draftShown()
    await waitFor(() => { expect(host.methods).toContain('mail.status') })
  }, 20_000)
})

describe('with no Mail account', () => {
  it('shows Connect beside "Open in my mail app"', async () => {
    await draftShown()
    await waitFor(() => { expect(connectButton()).not.toBeNull() })
    expect(mailAppAction()?.textContent).toBe('Open in my mail app')
    expect(sendRow()!.contains(mailAppAction())).toBe(true)
  }, 20_000)

  it('Connect opens the settings page in a full tab', async () => {
    await draftShown()
    await waitFor(() => { expect(connectButton()).not.toBeNull() })
    fireEvent.click(connectButton()!)
    await waitFor(() => { expect(created).toEqual([SETTINGS]) })
  }, 20_000)

  it('Connect focuses the settings page when it is already open, and opens no second one', async () => {
    tabs.push({ id: 55, url: SETTINGS, title: 'Settings', active: false, windowId: 1 })
    await draftShown()
    await waitFor(() => { expect(connectButton()).not.toBeNull() })
    fireEvent.click(connectButton()!)
    await waitFor(() => { expect(focusedTabs).toEqual([55]) })
    expect(created).toEqual([])
  }, 20_000)

  it('the Draft is still written and shown', async () => {
    await draftShown()
    expect(host.emailDrafts).toHaveLength(1)
    expect(bodyInput()!.value).toContain('Ada Lovelace')
  }, 20_000)
})

describe('with a connected Mail account', () => {
  it('shows no Connect', async () => {
    host.mailStatus = () => CONNECTED
    await draftShown()
    await waitFor(() => { expect(host.methods).toContain('mail.status') })
    // Give the answer time to land before asserting its absence.
    await new Promise((ok) => setTimeout(ok, 50))
    expect(connectButton()).toBeNull()
    expect(mailAppAction()).not.toBeNull()
  }, 20_000)
})

describe('the Draft never waits for the Mail account', () => {
  it('is requested while mail.status has not answered', async () => {
    host.mailStatus = () => new Promise<MailStatus>(() => {})
    await draftShown()
    expect(host.emailDrafts).toHaveLength(1)
    expect(connectButton()).toBeNull()
  }, 20_000)

  it('is requested when mail.status fails, and no Connect shows', async () => {
    host.mailStatus = () => ({ error: { kind: 'process', message: 'this Native host has no Mail account driver' } })
    await draftShown()
    await waitFor(() => { expect(host.methods).toContain('mail.status') })
    expect(host.emailDrafts).toHaveLength(1)
    await new Promise((ok) => setTimeout(ok, 50))
    expect(connectButton()).toBeNull()
  }, 20_000)
})
