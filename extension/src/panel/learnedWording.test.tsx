import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { field, installHeldMappingHost, rowOf, status, tierOf } from './testing/heldMapping'

/**
 * Ticket #35 at the panel seam (spec #6, testing decision 3): an Option the
 * user accepts for a Field answered from a Known key is sent to the Native host
 * as a Learned wording, with the key and the stored Value it stood for. So is
 * an Option the user picks from the picker after a miss. A pick that stands
 * for a Saved answer is never one. The fake page offers its Options only once
 * a Fill opens the Control.
 */

const RELOCATE = 'Are you open to relocation?'
const OPEN = 'Yes, I am open to relocating'
const STAY = 'No, I prefer to stay where I am'
const RELOCATE_OPTIONS = ['Select...', OPEN, STAY]

const host = installHeldMappingHost()
beforeEach(() => {
  host.nothingPending = true
})

const row = (label: string): HTMLElement => rowOf(label) as HTMLElement

async function mountScanned(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(status()).toBe('done') })
}

/** Lets every request the last click started reach the fake host. */
const settle = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 30)) }

describe('a relocation Value whose Fill missed on a dropdown that says yes in its own words', () => {
  beforeEach(() => {
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.firstValues = { 0: 'Yes' }
    host.firstCandidates = { 0: ['Yes', 'Sim'] }
    host.firstPatch = { 0: { key: 'relocate', source: 'answer_bank', reason: 'recognizer:relocate' } }
    host.offers = { 0: RELOCATE_OPTIONS }
  })

  it('accepting the model-picked Option stores its wording with the key and the Value it stood for', async () => {
    host.pick = () => ({ position: 1 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('proposed') })
    expect(host.learned).toEqual([])
    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.page[0]).toBe(OPEN) })
    await waitFor(() => { expect(host.learned).toEqual([{ key: 'relocate', value: 'Yes', wording: OPEN }]) })
  })

  it('a pick that is shown but not accepted stores nothing', async () => {
    host.pick = () => ({ position: 1 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('proposed') })
    await settle()
    expect(host.learned).toEqual([])
  })

  it('an Accept the page refuses stores nothing', async () => {
    host.pick = () => ({ position: 1 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('proposed') })
    host.refuse = { 0: 'click-rejected' }
    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('needs_input') })
    await settle()
    expect(host.learned).toEqual([])
  })

  it('picking an Option from the picker after the model found none, then filling, stores it the same way', async () => {
    host.pick = () => ({ position: null })
    await mountScanned()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    expect(tierOf(RELOCATE)).toBe('needs_input')
    fireEvent.change(screen.getByLabelText(RELOCATE), { target: { value: OPEN } })
    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Fill' }))
    await waitFor(() => { expect(host.page[0]).toBe(OPEN) })
    await waitFor(() => { expect(host.learned).toEqual([{ key: 'relocate', value: 'Yes', wording: OPEN }]) })
  })

  it('an Accept the user changed to another Option first stores nothing: that answers this role, it is no wording of the stored Value', async () => {
    host.pick = () => ({ position: 1 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('proposed') })
    fireEvent.change(screen.getByLabelText(RELOCATE), { target: { value: STAY } })
    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.page[0]).toBe(STAY) })
    await settle()
    expect(host.learned).toEqual([])
  })

  it('text typed into the picker that is none of the Options is never learned', async () => {
    host.pick = () => ({ position: null })
    host.offers = { 0: RELOCATE_OPTIONS }
    await mountScanned()
    await waitFor(() => { expect(host.picks).toHaveLength(1) })
    // The page takes it (the fake page has no Option equal, so it refuses);
    // either way, what is not an Option is never a wording.
    fireEvent.change(screen.getByLabelText(RELOCATE), { target: { value: 'Maybe' } })
    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Fill' }))
    await settle()
    expect(host.learned).toEqual([])
  })
})

describe('a pick that stands for a Saved answer', () => {
  const BEFORE = 'Have you previously worked for this company?'
  const PROSE = 'I have never worked for this company before, though I have long admired its engineering culture.'

  it('accepting it stores no Learned wording', async () => {
    host.fields = [field(0, BEFORE, { kind: 'combobox' })]
    host.firstValues = { 0: PROSE }
    host.firstPatch = { 0: { key: null, source: 'saved_answer', answerId: 4, reason: 'exact-match' } }
    host.offers = { 0: ['Select...', 'Yes', 'No'] }
    host.pick = () => ({ position: 2 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(BEFORE)).toBe('proposed') })
    fireEvent.click(within(row(BEFORE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.page[0]).toBe('No') })
    await settle()
    expect(host.learned).toEqual([])
  })

  it('under a recognized key, accepting it stores no Learned wording either', async () => {
    host.fields = [field(0, RELOCATE, { kind: 'combobox' })]
    host.firstNeedsInput = [0]
    host.firstPatch = { 0: { key: 'relocate', answerId: 9, reason: 'exact-match:key-fallback:no-offered-option', identifiedValue: 'Happy to move for the right role.' } }
    host.offers = { 0: RELOCATE_OPTIONS }
    host.pick = () => ({ position: 1 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(RELOCATE)).toBe('proposed') })
    fireEvent.click(within(row(RELOCATE)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.page[0]).toBe(OPEN) })
    await settle()
    expect(host.learned).toEqual([])
  })
})

describe('a pronoun checkbox group that offers no Option equal to the stored pronouns', () => {
  const PRONOUNS = ['He/him', 'She / her (elle)', 'They/them']

  it('accepting the model-picked Option stores it for the pronouns key and the stored pronouns', async () => {
    host.fields = [field(0, 'Pronouns', { kind: 'checkboxgroup', options: PRONOUNS })]
    host.firstNeedsInput = [0]
    host.firstPatch = { 0: { key: 'pronouns', reason: 'custom', identifiedValue: 'she/her' } }
    host.offers = { 0: PRONOUNS }
    host.pick = () => ({ position: 1 })
    await mountScanned()
    await waitFor(() => { expect(tierOf('Pronouns')).toBe('proposed') })
    fireEvent.click(within(row('Pronouns')).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.page[0]).toBe('She / her (elle)') })
    await waitFor(() => { expect(host.learned).toEqual([{ key: 'pronouns', value: 'she/her', wording: 'She / her (elle)' }]) })
  })
})

describe('a work-authorization Field, a derived answer', () => {
  it('stores the accepted Option for the yes the Resolution gave', async () => {
    const AUTH = 'Are you legally authorized to work in Germany?'
    host.fields = [field(0, AUTH, { kind: 'combobox' })]
    host.firstValues = { 0: 'Yes' }
    host.firstCandidates = { 0: ['Yes', 'Sim'] }
    host.firstPatch = { 0: { key: 'workAuth', source: 'answer_bank', reason: 'country-named' } }
    host.offers = { 0: ['Select...', 'Yes, I hold the right to work', 'No, I would need a permit'] }
    host.pick = () => ({ position: 1 })
    await mountScanned()
    await waitFor(() => { expect(tierOf(AUTH)).toBe('proposed') })
    fireEvent.click(within(row(AUTH)).getByRole('button', { name: 'Accept' }))
    await waitFor(() => { expect(host.learned).toEqual([{ key: 'workAuth', value: 'Yes', wording: 'Yes, I hold the right to work' }]) })
  })
})
