import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App, hostnameOf } from './App'

beforeEach(() => {
  // The compile-time seam is on in tests (vitest define), so the fake host answers.
  window.history.replaceState(null, '', '/?jffFakeHost=1')
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: 'https://jobs.acme.com/apply', title: 'Engineer at Acme' }]),
      get: vi.fn(async () => ({ id: 7, url: 'https://jobs.acme.com/apply', title: 'Engineer at Acme' })),
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(async () => ({ ok: true, replies: [], frames: [] })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    // `remove` is required: onScan clears this tab's stale snapshot keys first.
    storage: { session: { get: vi.fn(async () => ({})), remove: vi.fn(async () => undefined) } },
  }
})

describe('hostnameOf', () => {
  // Regression: the previous `tab.url === undefined ? '' : new URL(tab.url).hostname`
  // threw on '' — the value Chrome reports for a tab that has not committed a
  // navigation. Thrown out of the auto-scan effect it killed the scan and logged a
  // console error, which the foundation smoke's zero-console-errors rule caught
  // intermittently.
  it('returns no hostname for a tab that has not committed a navigation', () => {
    expect(hostnameOf('')).toBe('')
    expect(hostnameOf(undefined)).toBe('')
  })

  it('returns no hostname for an unparseable url instead of throwing', () => {
    expect(hostnameOf('not a url')).toBe('')
  })

  it('still reads the hostname of a real url', () => {
    expect(hostnameOf('https://jobs.acme.com/apply')).toBe('jobs.acme.com')
  })
})

describe('App', () => {
  it('mounts the full review surface against the fake host', async () => {
    render(<App />)
    expect(await screen.findByText(/Host ready/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Scan' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save answers' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pick job description' })).toBeTruthy()
    // The auto-scan guessed the company from the stubbed tab title.
    expect(await screen.findByDisplayValue('Acme')).toBeTruthy()
  })

  it('unlocks the facts editor only once the host has answered', async () => {
    // The host DELETES a key written as '' (Task 5 writeKv), so a Save on a
    // not-yet-loaded editor would wipe the whole profile. ProfileEditor.test.tsx
    // proves the disabled state; this proves App actually wires `loaded` to the
    // profile.get/answerBank.get round-trip instead of hard-coding true.
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit your facts' }))
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Save facts' }) as HTMLButtonElement).disabled).toBe(false)
    })
  })
})
