import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import type { ApplicationEmail, AppliedTexts, HostResponse } from '@jff/shared'
import { App } from './App'
import type { AppliedJobRow } from './ApplicationsView'
import { installHeldMappingHost } from './testing/heldMapping'

/**
 * An email Applied job in the Applications view (spec #66, ticket #75), at
 * the panel seam: the whole App against a fake Native host. The list carries
 * no stored text; opening an email Applied job reads its texts with
 * `applied.get` and shows its Application emails read only, as the Native
 * host returns them, newest first.
 */

const host = installHeldMappingHost()

const FORM_JOB: AppliedJobRow = {
  id: 1, url: 'https://jobs.example.com/1', canonicalUrl: 'https://jobs.example.com/1',
  company: 'Acme', jobTitle: 'Engineer', markedAt: '2026-11-01T12:00:00.000Z', channel: 'form',
}
const EMAIL_JOB: AppliedJobRow = {
  id: 2, url: 'https://careers.example.com/jobs/2', canonicalUrl: 'https://careers.example.com/jobs/2',
  company: 'Example Ltd', jobTitle: 'Analyst', markedAt: '2026-11-18T12:00:00.000Z', channel: 'email',
}

const NEWER: ApplicationEmail = {
  applyAddress: 'hr@example.org', senderAddress: null, subject: 'Candidatura: Analista',
  body: 'Olá,\n\nGostaria de me candidatar.\n\nAtenciosamente,\nAda Lovelace', attachmentNames: [],
  sentAt: '2026-11-18T12:00:00.000Z', language: 'pt', gmailMessageId: null, gmailThreadId: null,
  route: 'mail_app', aiDrafted: true, edited: true, model: 'claude-opus-5-5',
}
const OLDER: ApplicationEmail = {
  ...NEWER, applyAddress: 'jobs@example.org', subject: 'Application: Analyst',
  body: 'Hello,\n\nI would like to apply.\n\nBest regards,\nAda Lovelace', sentAt: '2026-11-10T09:00:00.000Z',
  language: 'en', edited: false,
}

let gets: unknown[]

beforeEach(() => {
  gets = []
  const base = window.__jffHostBridge!
  window.__jffHostBridge = async (req): Promise<HostResponse> => {
    if (req.method === 'applied.list') return { requestId: req.requestId, ok: true, result: { jobs: [EMAIL_JOB, FORM_JOB] } }
    if (req.method === 'applied.get') {
      gets.push(req.params)
      const texts: AppliedTexts = { id: EMAIL_JOB.id, proseAnswers: [], emails: [NEWER, OLDER] }
      return { requestId: req.requestId, ok: true, result: texts }
    }
    return await base(req)
  }
})

const rowOf = (title: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('[data-jff-apps] li')].find((li) => li.textContent?.includes(title))!

async function applicationsShown(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(document.querySelector('[data-jff-nav-apps]')).not.toBeNull() }, { timeout: 8_000 })
  fireEvent.click(document.querySelector('[data-jff-nav-apps]')!)
  await waitFor(() => { expect(document.querySelector('[data-jff-apps="1"]')).not.toBeNull() })
}

describe('the Applications view shows an email Applied job\'s Application email', () => {
  it('reads nothing until the email Applied job is opened, and the form one offers no email', async () => {
    await applicationsShown()
    expect(gets).toEqual([])
    expect(host.methods).not.toContain('applied.get')
    expect(within(rowOf('Engineer')).queryByRole('button', { name: /email/i })).toBeNull()
    expect(document.querySelector('[data-jff-app-email]')).toBeNull()
  }, 20_000)

  it('opens it read only, newest first, with the To address, the subject, the body and how it left', async () => {
    await applicationsShown()
    fireEvent.click(within(rowOf('Analyst')).getByRole('button', { name: 'Show the Application email' }))
    await waitFor(() => { expect(document.querySelectorAll('[data-jff-app-email]')).toHaveLength(2) })
    expect(gets).toEqual([{ id: EMAIL_JOB.id }])

    const shown = [...document.querySelectorAll<HTMLElement>('[data-jff-app-email]')]
    expect(shown.map((e) => e.querySelector('[data-jff-app-email-subject]')?.textContent)).toEqual([NEWER.subject, OLDER.subject])
    const [first] = shown
    expect(first!.querySelector('[data-jff-app-email-to]')?.textContent).toContain('hr@example.org')
    // The body keeps its line breaks.
    expect(first!.querySelector('[data-jff-app-email-body]')?.textContent).toBe(NEWER.body)
    expect(first!.textContent).toMatch(/mail app/i)
    expect(first!.textContent).not.toMatch(/From/)
    // Read only: no control can change what was sent.
    for (const e of shown) {
      expect(e.querySelector('input, textarea, select, button, [contenteditable]')).toBeNull()
    }

    fireEvent.click(within(rowOf('Analyst')).getByRole('button', { name: 'Hide the Application email' }))
    expect(document.querySelector('[data-jff-app-email]')).toBeNull()
  }, 20_000)

  it('says so when the texts cannot be read', async () => {
    const base = window.__jffHostBridge!
    window.__jffHostBridge = async (req): Promise<HostResponse> => (req.method === 'applied.get'
      ? { requestId: req.requestId, ok: false, error: { kind: 'db', message: 'database is locked' } }
      : await base(req))
    await applicationsShown()
    fireEvent.click(within(rowOf('Analyst')).getByRole('button', { name: 'Show the Application email' }))
    await waitFor(() => { expect(within(rowOf('Analyst')).getByText('Could not load the Application email.')).toBeTruthy() })
  }, 20_000)
})
