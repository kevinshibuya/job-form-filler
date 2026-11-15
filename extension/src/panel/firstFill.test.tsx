import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { EnumField } from '@jff/shared'
import { App } from './App'
import {
  field, installHeldMappingHost, mapped, release, resolution, rowLabels, status, tierOf, waitingLabels,
} from './testing/heldMapping'

/**
 * Resolution in two steps, at the panel seam: the App renders against a fake
 * Native host whose `resolve.mapping` reply each test holds back and releases.
 * What is asserted is what the page and the user see: which values the page
 * holds, which rows show, and what the status line says.
 */

/** fid 0 and 1 need no model; 2 and 3 wait on Mapping. */
const PAGE = [field(0, 'First name'), field(1, 'Email'), field(2, 'Why us?'), field(3, 'Salary expectation')]

/** What Mapping decides for the two pending Fields. */
const mappingFor = (fields: EnumField[]) => fields.map((f) => f.fid === 3
  ? resolution(f, { tier: 'proposed', value: '120000', source: 'llm_key', key: 'salary', reason: 'llm-key:salary' })
  : resolution(f, {}))

const host = installHeldMappingHost()
beforeEach(() => {
  host.fields = PAGE
  host.firstValues = { 0: 'Ada', 1: 'ada@example.com' }
  host.mappingFor = mappingFor
})

/** Mount and wait until the first step has settled with Mapping held. */
async function mountHeld(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(host.held).toHaveLength(1) })
  await waitFor(() => { expect(rowLabels()).toEqual(['First name', 'Email']) })
}

describe('First Fill lands before Mapping answers', () => {
  it('fills the identity Fields and shows their rows while the Mapping reply is held', async () => {
    await mountHeld()
    // On the page, not just in the panel.
    expect(host.page).toEqual({ 0: 'Ada', 1: 'ada@example.com' })
    expect(tierOf('First name')).toBe('auto')
    expect(tierOf('Email')).toBe('auto')
    // The pending Fields carry no Resolution yet: they are still being matched.
    expect(rowLabels()).not.toContain('Why us?')
    expect(waitingLabels()).toEqual(['Why us?', 'Salary expectation'])
    expect(status()).toBe('matching')
    // The second request carries the pending Fields only.
    expect(host.held[0]!.fields.map((f) => f.fid)).toEqual([2, 3])
  })

  it('adds a row per pending Field when the reply lands, and fills nothing again', async () => {
    await mountHeld()
    const fillsBefore = host.fills.length
    await release(host, (h) => mapped(host, h))
    await waitFor(() => { expect(rowLabels()).toEqual(['First name', 'Email', 'Why us?', 'Salary expectation']) })
    expect(tierOf('Why us?')).toBe('needs_input')
    expect(tierOf('Salary expectation')).toBe('proposed')
    expect(host.fills).toHaveLength(fillsBefore)
    expect(host.fills.flatMap((f) => f.fids)).toEqual([0, 1])
    await waitFor(() => { expect(status()).toBe('done') })
    expect(screen.getByText('✓ 2 filled, 0 already on page, 1 proposed, 1 need input')).toBeTruthy()
  })

  it('makes every pending Field Needs input with the error when the request fails outright', async () => {
    await mountHeld()
    await release(host, (h) => ({ requestId: h.requestId, ok: false, error: { kind: 'rate_limit', message: 'limit' } }))
    await waitFor(() => { expect(rowLabels()).toHaveLength(4) })
    expect(tierOf('Why us?')).toBe('needs_input')
    expect(tierOf('Salary expectation')).toBe('needs_input')
    expect(status()).toBe('failed')
    expect(document.querySelector('[data-jff-banner="error"]')?.textContent).toMatch(/rate limit/i)
    // What the first step filled stays filled.
    expect(host.page).toEqual({ 0: 'Ada', 1: 'ada@example.com' })
    expect(tierOf('First name')).toBe('auto')
  })

  it('does the same for a reply that carries a model error', async () => {
    await mountHeld()
    await release(host, (h) => mapped(host, h, { kind: 'rate_limit', message: 'limit' }))
    await waitFor(() => { expect(rowLabels()).toHaveLength(4) })
    expect(tierOf('Why us?')).toBe('needs_input')
    expect(tierOf('Salary expectation')).toBe('needs_input')
    expect(status()).toBe('failed')
    expect(document.querySelector('[data-jff-banner="error"]')?.textContent).toMatch(/rate limit/i)
    expect(tierOf('First name')).toBe('auto')
  })

  it('starts a newer Scan without waiting, and drops the older reply when it lands', async () => {
    await mountHeld()
    const scanButton = await screen.findByRole('button', { name: 'Scan' })
    await waitFor(() => { expect((scanButton as HTMLButtonElement).disabled).toBe(false) })
    const scansBefore = host.scans
    fireEvent.click(scanButton)
    // The newer Scan ran its whole first step with the old reply still held.
    await waitFor(() => { expect(host.held).toHaveLength(2) })
    expect(host.scans).toBeGreaterThan(scansBefore)
    await waitFor(() => { expect(status()).toBe('matching') })
    const fillsBefore = host.fills.length

    // The OLD reply now lands, with an auto answer it would fill if it counted.
    await release(host, (h) => ({ requestId: h.requestId, ok: true, result: { epoch: 0, llmError: null, resolutions: h.fields.map((f) =>
      resolution(f, { tier: 'auto', value: 'STALE', source: 'answer_bank', reason: 'stale' })) } }))
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(rowLabels()).toEqual(['First name', 'Email'])
    expect(host.fills).toHaveLength(fillsBefore)
    expect(Object.values(host.page)).not.toContain('STALE')
    expect(status()).toBe('matching')

    // The newer Scan's own reply still lands.
    await release(host, (h) => mapped(host, h))
    await waitFor(() => { expect(rowLabels()).toHaveLength(4) })
  })

  it('sends no second request when nothing is pending', async () => {
    host.nothingPending = true
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    expect(host.firstRequests).toHaveLength(1)
    expect(host.held).toHaveLength(0)
    expect(host.mappingCount).toBe(0)
    expect(rowLabels()).toHaveLength(4)
  })

  it('keeps an edit typed into a first-step row while the reply is held', async () => {
    await mountHeld()
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Augusta' } })
    await release(host, (h) => mapped(host, h))
    await waitFor(() => { expect(rowLabels()).toHaveLength(4) })
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Augusta')
  })
})
