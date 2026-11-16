import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { EnumField } from '@jff/shared'
import { App } from './App'
import { field, installHeldMappingHost, mapped, release, resolution, rowOf, status, tierOf } from './testing/heldMapping'

/**
 * Ticket #26 at the panel seam (spec #6, testing decision 3): the Side panel
 * keeps a Resolution's candidate words with its row and sends them with every
 * Fill of that Value — the Fill after a Scan, a Fill the user starts, and
 * Accept — and sends none once the user has edited the Value. Asserted on the
 * JFF_FILL messages the fake page receives. The persona's country is not the
 * maintainer's.
 */

const GERMANY = ['Germany', 'Alemanha']

/** fid 0 is answered by the first step; fid 1 waits on Mapping. */
const PAGE = [field(0, 'Country', { kind: 'combobox' }), field(1, 'Where are you based?', { kind: 'combobox' })]

const proposeCountry = (fields: EnumField[]) => fields.map((f) => resolution(f, {
  tier: 'proposed', value: 'Germany', source: 'llm_key', key: 'country', reason: 'llm-key:country', candidates: GERMANY,
}))

const host = installHeldMappingHost()
beforeEach(() => {
  host.fields = PAGE
  host.firstValues = { 0: 'Germany' }
  host.firstCandidates = { 0: GERMANY }
  host.mappingFor = proposeCountry
})

/** Mount, let the first step fill, and land the Mapping reply. */
async function mountScanned(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(host.held).toHaveLength(1) })
  await release(host, (h) => mapped(host, h))
  await waitFor(() => { expect(tierOf('Where are you based?')).toBe('proposed') })
  await waitFor(() => { expect(status()).toBe('done') })
}

const sentFor = (fid: number) => host.sent.filter((s) => s.fid === fid)
const button = (label: string, name: string): HTMLElement => within(rowOf(label) as HTMLElement).getByRole('button', { name })

describe('candidate words travel with every Fill of a Value', () => {
  it('the Fill after a Scan carries the Resolution\'s candidate words', async () => {
    await mountScanned()
    expect(sentFor(0)).toEqual([{ fid: 0, value: 'Germany', candidates: GERMANY }])
  })

  it('Accept carries them', async () => {
    await mountScanned()
    fireEvent.click(button('Where are you based?', 'Accept'))
    await waitFor(() => { expect(sentFor(1)).toHaveLength(1) })
    expect(sentFor(1)).toEqual([{ fid: 1, value: 'Germany', candidates: GERMANY }])
  })

  it('a Fill the user starts carries them, after the Scan\'s Fill missed', async () => {
    host.refuse = { 0: 'no-matching-option' }
    await mountScanned()
    expect(tierOf('Country')).toBe('needs_input')
    delete host.refuse[0]
    fireEvent.click(button('Country', 'Fill'))
    await waitFor(() => { expect(sentFor(0)).toHaveLength(2) })
    expect(sentFor(0)[1]).toEqual({ fid: 0, value: 'Germany', candidates: GERMANY })
  })

  it('after the user edits the Value, Accept carries no candidate words, only the edited text', async () => {
    await mountScanned()
    fireEvent.change(screen.getByLabelText('Where are you based?'), { target: { value: 'France' } })
    fireEvent.click(button('Where are you based?', 'Accept'))
    await waitFor(() => { expect(sentFor(1)).toHaveLength(1) })
    expect(sentFor(1)).toEqual([{ fid: 1, value: 'France' }])
  })

  it('after the user edits the Value, a Fill they start carries none either', async () => {
    host.refuse = { 0: 'no-matching-option' }
    await mountScanned()
    delete host.refuse[0]
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'Alemanha' } })
    fireEvent.click(button('Country', 'Fill'))
    await waitFor(() => { expect(sentFor(0)).toHaveLength(2) })
    expect(sentFor(0)[1]).toEqual({ fid: 0, value: 'Alemanha' })
  })

  it('a Value with no candidate words is sent without any', async () => {
    host.firstCandidates = {}
    await mountScanned()
    expect(sentFor(0)).toEqual([{ fid: 0, value: 'Germany' }])
  })
})
