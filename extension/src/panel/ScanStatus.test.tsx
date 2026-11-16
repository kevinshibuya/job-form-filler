import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScanStatus, type ScanUiState } from './ScanStatus'
import type { FrameReport } from './scan'

const okReport: FrameReport = { frameId: 0, url: 'https://top.example/apply', fields: 3, error: null }
const badReport: FrameReport = { frameId: 7, url: 'https://ats.example/embed', fields: null, error: 'no receiver' }

const statusEl = () => document.querySelector('[data-jff-status]')

describe('ScanStatus', () => {
  it('renders nothing before any scan has started', () => {
    render(<ScanStatus status={null} reports={[]} />)
    expect(statusEl()).toBeNull()
  })

  it.each<[ScanUiState, string]>([
    [{ kind: 'connecting' }, 'Waiting for the local host…'],
    [{ kind: 'injecting' }, 'Reaching into the page…'],
    [{ kind: 'enumerating', frames: 7 }, 'Scanning page (7 frames)…'],
    [{ kind: 'retrying' }, 'No fields yet — looking again…'],
    [{ kind: 'resolving', fields: 12 }, 'Matching 12 fields… (an AI call can take a minute)'],
    [{ kind: 'done', filled: 8, alreadyOnPage: 2, proposed: 2, needsInput: 3 }, '✓ 8 filled, 2 already on page, 2 proposed, 3 need input'],
    [{ kind: 'matching', filled: 2, alreadyOnPage: 0, proposed: 0, needsInput: 1, waiting: 4 }, '2 filled, 0 already on page, 0 proposed, 1 need input, 4 still being matched…'],
    [{ kind: 'empty', frames: 7 }, '⚠ Scanned 7 frames, found no form fields. Open the application form, then Scan again.'],
    [{ kind: 'captcha' }, '⚠ CAPTCHA active — nothing was filled.'],
    [{ kind: 'failed', reason: 'boom' }, '✕ Scan failed: boom'],
    [{ kind: 'failed', reason: 'boom', counts: { filled: 2, alreadyOnPage: 0, proposed: 1, needsInput: 3 } }, '2 filled, 0 already on page, 1 proposed, 3 need input · ✕ Matching failed: boom'],
    [{ kind: 'action_failed', reason: 'Fill failed: frame gone' }, '✕ Fill failed: frame gone'],
    [{ kind: 'superseded' }, 'Page changed — finishing the old scan before rescanning…'],
  ])('renders the spec copy for %j', (status, copy) => {
    render(<ScanStatus status={status} reports={[]} />)
    expect(screen.getByText(copy)).toBeTruthy()
    expect(statusEl()!.getAttribute('data-jff-status')).toBe(status.kind)
  })

  it.each<[ScanUiState, string]>([
    [{ kind: 'empty', frames: 2, ats: 'ashby' }, ' On Ashby the form is under the "Application" tab. Open it, then Scan again.'],
    [{ kind: 'empty', frames: 2, ats: 'lever' }, ' On Lever the form opens from "Apply for this job". Open it, then Scan again.'],
    [{ kind: 'empty', frames: 2, ats: 'greenhouse' }, ''],
    [{ kind: 'empty', frames: 2, ats: 'generic' }, ''],
    [{ kind: 'empty', frames: 2 }, ''],
  ])('follows the empty state with its ATS\'s hint, when it has one: %j', (status, hint) => {
    render(<ScanStatus status={status} reports={[]} />)
    expect(statusEl()!.querySelector('p')!.textContent)
      .toBe(`⚠ Scanned 2 frames, found no form fields. Open the application form, then Scan again.${hint}`)
  })

  it('shows per-frame diagnostics on an empty outcome', () => {
    render(<ScanStatus status={{ kind: 'empty', frames: 2 }} reports={[okReport, badReport]} />)
    const details = document.querySelector('[data-jff-diagnostics]')
    expect(details).not.toBeNull()
    expect(details!.textContent).toContain('https://top.example/apply')
    expect(details!.textContent).toContain('3 fields')
    expect(details!.textContent).toContain('no receiver')
  })

  it('shows diagnostics on done ONLY when a frame reported an error', () => {
    const { rerender } = render(<ScanStatus status={{ kind: 'done', filled: 1, alreadyOnPage: 0, proposed: 0, needsInput: 0 }} reports={[okReport]} />)
    expect(document.querySelector('[data-jff-diagnostics]')).toBeNull()
    rerender(<ScanStatus status={{ kind: 'done', filled: 1, alreadyOnPage: 0, proposed: 0, needsInput: 0 }} reports={[okReport, badReport]} />)
    expect(document.querySelector('[data-jff-diagnostics]')).not.toBeNull()
  })

  it('hides diagnostics while a scan is running', () => {
    render(<ScanStatus status={{ kind: 'resolving', fields: 3 }} reports={[badReport]} />)
    expect(document.querySelector('[data-jff-diagnostics]')).toBeNull()
  })

  it('shows the relay error in diagnostics when the scan failed before any frame replied', () => {
    // frameId -1 is the App's synthetic "the relay itself failed" report; it must
    // render as evidence, not as a bogus frame number.
    const relayReport: FrameReport = { frameId: -1, url: null, fields: null, error: 'Could not reach the page.' }
    render(<ScanStatus status={{ kind: 'failed', reason: 'Could not reach the page.' }} reports={[relayReport]} />)
    const details = document.querySelector('[data-jff-diagnostics]')
    expect(details).not.toBeNull()
    expect(details!.textContent).toContain('relay')
    expect(details!.textContent).toContain('Could not reach the page.')
  })

  it('shows no waiting count once nothing is waiting', () => {
    render(<ScanStatus status={{ kind: 'done', filled: 2, alreadyOnPage: 0, proposed: 0, needsInput: 1 }} reports={[]} />)
    expect(statusEl()!.textContent).not.toMatch(/still being matched/)
  })

  it('hides diagnostics while Mapping is still running', () => {
    render(<ScanStatus status={{ kind: 'matching', filled: 2, alreadyOnPage: 0, proposed: 0, needsInput: 0, waiting: 1 }} reports={[badReport]} />)
    expect(document.querySelector('[data-jff-diagnostics]')).toBeNull()
  })
})
