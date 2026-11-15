import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { EnumField } from '@jff/shared'
import { App } from './App'
import {
  field, installHeldMappingHost, mapped, release, resolution, rowLabels, rowOf, status, statusText, tierOf,
  waitingLabels,
} from './testing/heldMapping'

/**
 * Rows still being matched say so. The App renders against a fake Native host
 * that holds the `resolve.mapping` reply back; while it is held, every pending
 * Field has a waiting row, and the status line counts those rows apart.
 */

const PENDING = ['Why us?', 'Salary expectation', 'Pronouns', 'I agree to the privacy notice']
const PAGE = [
  field(0, 'First name'),
  field(1, 'Email'),
  // The first step decides this one as Needs input: it is not waiting.
  field(2, 'Anything else?'),
  field(3, 'Why us?'),
  field(4, 'Salary expectation'),
  field(5, 'Pronouns', { kind: 'checkboxgroup', options: ['she/her', 'he/him', 'they/them'] }),
  field(6, 'I agree to the privacy notice', { kind: 'checkbox' }),
]

const mappingFor = (fields: EnumField[]) => fields.map((f) => f.fid === 4
  ? resolution(f, { tier: 'proposed', value: '120000', source: 'llm_key', key: 'salary', reason: 'llm-key:salary' })
  : resolution(f, {}))

const host = installHeldMappingHost()
beforeEach(() => {
  host.fields = PAGE
  host.firstValues = { 0: 'Ada', 1: 'ada@example.com' }
  host.firstNeedsInput = [2]
  host.mappingFor = mappingFor
})

/** Mount and wait until the first step has settled with Mapping held. */
async function mountHeld(): Promise<ReturnType<typeof render>> {
  const view = render(<App />)
  await waitFor(() => { expect(host.held).toHaveLength(1) })
  await waitFor(() => { expect(rowLabels()).toEqual(['First name', 'Email', 'Anything else?']) })
  return view
}

const generateAllText = (): string | null | undefined => document.querySelector('[data-jff-generate-all] button')?.textContent
const buttonsOf = (label: string): HTMLButtonElement[] => [...rowOf(label)!.querySelectorAll('button')]

describe('rows still being matched say so', () => {
  it('shows a waiting row for every pending Field, with no Resolution outcome, while the reply is held', async () => {
    await mountHeld()
    // In document order, between the rows the first step decided.
    expect(waitingLabels()).toEqual(PENDING)
    for (const label of PENDING) {
      const li = rowOf(label)!
      expect(li.textContent).toMatch(/still being matched/i)
      expect(li.hasAttribute('data-jff-tier')).toBe(false)
      expect(li.querySelector('[data-jff-tier-badge]')).toBeNull()
    }
    const order = [...document.querySelectorAll('[data-jff-rows] li')].map((li) => li.querySelector(':scope > div .font-semibold')?.textContent)
    expect(order).toEqual(PAGE.map((f) => f.label))
  })

  it('keeps a waiting row\'s Accept, Fill and Generate disabled, and leaves it out of Generate all remaining', async () => {
    await mountHeld()
    for (const label of PENDING) {
      const buttons = buttonsOf(label)
      expect(buttons.map((b) => b.textContent)).toEqual(['Accept', 'Generate with AI', 'Fill'])
      for (const b of buttons) expect(b.disabled).toBe(true)
    }
    // Only the first step's Needs input row counts.
    expect(generateAllText()).toBe('Generate all remaining (1)')
  })

  it('counts the waiting rows beside a filled count that matches the page', async () => {
    await mountHeld()
    expect(status()).toBe('matching')
    expect(Object.keys(host.page)).toHaveLength(2)
    expect(statusText()).toBe('2 filled, 0 already on page, 0 proposed, 1 need input, 4 still being matched…')
  })

  it('turns each waiting row into its Resolution when the reply lands', async () => {
    await mountHeld()
    await release(host, (h) => mapped(host, h))
    await waitFor(() => { expect(waitingLabels()).toEqual([]) })
    expect(rowLabels()).toEqual(PAGE.map((f) => f.label))
    expect(tierOf('Why us?')).toBe('needs_input')
    expect(tierOf('Salary expectation')).toBe('proposed')
    expect(tierOf('Pronouns')).toBe('needs_input')
    expect(tierOf('I agree to the privacy notice')).toBe('needs_input')
    await waitFor(() => { expect(status()).toBe('done') })
    expect(statusText()).toBe('✓ 2 filled, 0 already on page, 1 proposed, 4 need input')
    expect(statusText()).not.toMatch(/still being matched/)
    // The landed Prose row now counts; the tick-box rows never do.
    expect(generateAllText()).toBe('Generate all remaining (2)')
    expect(buttonsOf('Salary expectation').find((b) => b.textContent === 'Accept')!.disabled).toBe(false)
  })

  it('turns every waiting row into Needs input with the error when the request fails outright', async () => {
    await mountHeld()
    await release(host, (h) => ({ requestId: h.requestId, ok: false, error: { kind: 'rate_limit', message: 'limit' } }))
    await waitFor(() => { expect(waitingLabels()).toEqual([]) })
    for (const label of PENDING) {
      expect(tierOf(label)).toBe('needs_input')
      expect(rowOf(label)!.textContent).toContain('llm-error:rate_limit')
    }
    expect(document.querySelector('[data-jff-banner="error"]')?.textContent).toMatch(/rate limit/i)
    expect(statusText()).not.toMatch(/still being matched/)
  })

  it('does the same for a reply that carries a model error', async () => {
    await mountHeld()
    await release(host, (h) => mapped(host, h, { kind: 'rate_limit', message: 'limit' }))
    await waitFor(() => { expect(waitingLabels()).toEqual([]) })
    for (const label of PENDING) {
      expect(tierOf(label)).toBe('needs_input')
      expect(rowOf(label)!.textContent).toContain('llm-error:rate_limit')
    }
    expect(document.querySelector('[data-jff-banner="error"]')?.textContent).toMatch(/rate limit/i)
  })

  it('makes a Field the reply leaves out Needs input too, so no row stays waiting', async () => {
    host.mappingFor = (fields) => mappingFor(fields).filter((r) => r.handle.fid !== 3)
    await mountHeld()
    await release(host, (h) => mapped(host, h))
    await waitFor(() => { expect(status()).toBe('done') })
    expect(waitingLabels()).toEqual([])
    expect(tierOf('Why us?')).toBe('needs_input')
  })

  it('shows no waiting row and no waiting count when nothing is pending', async () => {
    host.nothingPending = true
    render(<App />)
    await waitFor(() => { expect(status()).toBe('done') })
    expect(waitingLabels()).toEqual([])
    expect(rowLabels()).toHaveLength(PAGE.length)
    expect(statusText()).not.toMatch(/still being matched/)
  })

  it('shows a reopened Session\'s waiting rows as Needs input once their request is gone', async () => {
    const first = await mountHeld()
    // The first step's rows reached storage, waiting rows and all.
    await waitFor(() => {
      expect((host.storage['jff:session:7'] as { waiting?: string[] } | undefined)?.waiting).toHaveLength(4)
    })
    // The panel closes with the reply still out: that request is gone.
    first.unmount()
    // The reopened panel's own Scan stays on its first step, so what shows is
    // the stored Session.
    host.holdFirst = true
    render(<App />)
    await waitFor(() => { expect(rowLabels()).toEqual(PAGE.map((f) => f.label)) })
    expect(waitingLabels()).toEqual([])
    for (const label of PENDING) expect(tierOf(label)).toBe('needs_input')
    expect(screen.getAllByText(/Matching did not finish/)).toHaveLength(PENDING.length)
    expect(tierOf('First name')).toBe('auto')
  })
})
