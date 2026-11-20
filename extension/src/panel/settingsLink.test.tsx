import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from './App'
import { installHeldMappingHost } from './testing/heldMapping'

/**
 * The Side panel links to the settings page (spec #66, ticket #77). The page
 * opens in a full tab, and a second click focuses that tab instead of opening
 * another. The whole panel renders against the fake Native host; the fake
 * browser holds a list of tabs that `tabs.create` adds to.
 */

installHeldMappingHost()

const EXT = 'chrome-extension://jffextensionid/'
const SETTINGS = `${EXT}src/settings/index.html`

interface FakeTab { id: number; url: string; title: string; active: boolean; windowId: number }
let tabs: FakeTab[]
let created: string[]
let focusedTabs: number[]
let focusedWindows: number[]

beforeEach(() => {
  const job: FakeTab = { id: 7, url: 'https://jobs.example.com/apply', title: 'Engineer', active: true, windowId: 1 }
  tabs = [job]
  created = []
  focusedTabs = []
  focusedWindows = []
  const chrome = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome
  chrome.runtime!.getURL = (path: string) => `${EXT}${path.replace(/^\//, '')}`
  chrome.tabs!.query = async (q: { active?: boolean } = {}) => tabs.filter((t) => q.active !== true || t.active)
  chrome.tabs!.get = async (id: number) => tabs.find((t) => t.id === id)
  chrome.tabs!.create = async ({ url }: { url: string }) => {
    created.push(url)
    // A new tab in a second window, so a focus must name the tab's own window.
    const tab: FakeTab = { id: 100 + created.length, url, title: 'Settings', active: false, windowId: 2 }
    tabs.push(tab)
    return tab
  }
  chrome.tabs!.update = async (id: number, props: { active?: boolean }) => {
    if (props.active === true) focusedTabs.push(id)
    return tabs.find((t) => t.id === id)
  }
  chrome.windows!.update = async (id: number, props: { focused?: boolean }) => {
    if (props.focused === true) focusedWindows.push(id)
    return { id }
  }
})

const settingsLink = (): HTMLElement => screen.getByRole('link', { name: 'Settings' })

describe('the Side panel links to the settings page', () => {
  it('opens the settings page in a full tab', async () => {
    render(<App />)
    fireEvent.click(await waitFor(settingsLink))
    await waitFor(() => expect(created).toEqual([SETTINGS]))
    expect(focusedTabs).toEqual([])
  })

  it('a second click focuses the open settings tab and opens no new one', async () => {
    render(<App />)
    fireEvent.click(await waitFor(settingsLink))
    await waitFor(() => expect(created).toHaveLength(1))
    fireEvent.click(settingsLink())
    await waitFor(() => expect(focusedTabs).toEqual([101]))
    expect(focusedWindows).toEqual([2])
    expect(created).toHaveLength(1)
  })

  it('focuses a settings tab that sits on one of its own anchors', async () => {
    tabs.push({ id: 55, url: `${SETTINGS}#mail`, title: 'Settings', active: false, windowId: 1 })
    render(<App />)
    fireEvent.click(await waitFor(settingsLink))
    await waitFor(() => expect(focusedTabs).toEqual([55]))
    expect(created).toEqual([])
  })
})
