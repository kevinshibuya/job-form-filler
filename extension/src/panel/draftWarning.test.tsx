import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { EnumField, HostResponse, Resolution } from '@jff/shared'
import { App } from './App'
import { field, installHeldMappingHost, mapped, release, resolution, rowLabels, rowOf, status } from './testing/heldMapping'

/**
 * The Draft check's warning, at the panel seam: the App renders against a fake
 * Native host whose generate reply may carry sentences the Draft check found
 * unsupported. The row shows the Draft in its editor and, above it, a warning
 * quoting each sentence; the Draft stays the user's to edit and Fill.
 */

const ACCOMMODATION_LINE = 'I do not need any accommodations.'
const WARNED = 'Why do you want this role?'
const CLEAN = 'Tell us about a project you led'
const DRAFTS: Record<string, string> = {
  [WARNED]: `I like the work Acme does. ${ACCOMMODATION_LINE}`,
  [CLEAN]: 'I led the analytical engine notes.',
}

const PAGE: EnumField[] = [
  field(0, WARNED, { kind: 'textarea' }),
  field(1, CLEAN, { kind: 'textarea' }),
]
const mappingFor = (fields: EnumField[]): Resolution[] => fields.map((f) => resolution(f, { fieldClass: 'prose' }))

const host = installHeldMappingHost()
/** What the Draft check flags on the warned question's next Draft. */
let flags: string[]

beforeEach(() => {
  flags = [ACCOMMODATION_LINE]
  host.fields = PAGE
  host.mappingFor = mappingFor
  const base = window.__jffHostBridge!
  window.__jffHostBridge = async (req): Promise<HostResponse> => {
    if (req.method === 'generate') {
      const q = (req.params as { questionRaw: string }).questionRaw
      const result = q === WARNED && flags.length > 0
        ? { draft: DRAFTS[q], unsupportedClaims: flags }
        : { draft: DRAFTS[q] }
      return { requestId: req.requestId, ok: true, result }
    }
    return await base(req)
  }
})

async function mountAndGenerate(label: string): Promise<HTMLElement> {
  render(<App />)
  await waitFor(() => { expect(host.held).toHaveLength(1) })
  await release(host, (h) => mapped(host, h))
  await waitFor(() => { expect(rowLabels()).toHaveLength(PAGE.length) })
  await waitFor(() => { expect(status()).toBe('done') })
  const row = rowOf(label) as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'Generate with AI' }))
  await waitFor(() => { expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe(DRAFTS[label]) })
  return rowOf(label) as HTMLElement
}

const warningIn = (row: Element) => row.querySelector('[data-jff-draft-warning]')

describe('The Draft check warns about unsupported claims', () => {
  it('shows the Draft in its editor and the warning above it, quoting the sentence', async () => {
    const row = await mountAndGenerate(WARNED)
    const warning = warningIn(row)
    expect(warning).not.toBeNull()
    expect(warning!.textContent).toContain(ACCOMMODATION_LINE)
    const editor = screen.getByLabelText(WARNED)
    // The warning comes before the editor in the row.
    expect(warning!.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the Draft editable and fillable while the warning shows', async () => {
    const row = await mountAndGenerate(WARNED)
    const fixed = 'I like the work Acme does.'
    fireEvent.change(screen.getByLabelText(WARNED), { target: { value: fixed } })
    expect((screen.getByLabelText(WARNED) as HTMLTextAreaElement).value).toBe(fixed)
    expect(warningIn(rowOf(WARNED)!)).not.toBeNull()
    const fill = within(row).getByRole('button', { name: 'Fill' }) as HTMLButtonElement
    expect(fill.disabled).toBe(false)
    fireEvent.click(fill)
    await waitFor(() => { expect(host.page[0]).toBe(fixed) })
  })

  it('shows no warning on a Draft the Draft check did not flag', async () => {
    const row = await mountAndGenerate(CLEAN)
    expect(warningIn(row)).toBeNull()
    expect(document.querySelector('[data-jff-draft-warning]')).toBeNull()
    expect(within(row).getByRole('button', { name: 'Fill' })).not.toBeNull()
  })

  it('clears the warning when a new Draft comes back unflagged', async () => {
    const row = await mountAndGenerate(WARNED)
    expect(warningIn(row)).not.toBeNull()
    flags = []
    fireEvent.click(within(row).getByRole('button', { name: 'Generate with AI' }))
    await waitFor(() => { expect(warningIn(rowOf(WARNED)!)).toBeNull() })
    expect((screen.getByLabelText(WARNED) as HTMLTextAreaElement).value).toBe(DRAFTS[WARNED])
  })
})
