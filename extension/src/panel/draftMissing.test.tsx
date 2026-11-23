import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { EnumField, HostResponse, Resolution, SaveItem } from '@jff/shared'
import { App } from './App'
import type { Session } from './sessions'
import { field, installHeldMappingHost, mapped, release, resolution, rowLabels, rowOf, status } from './testing/heldMapping'

/**
 * A Draft that says what is missing (ticket #103), at the panel seam: the App
 * renders against a fake Native host whose generate reply may name a gap
 * beside the Draft. The row shows that gap above the Draft's editor while its
 * text is still that Draft, and "Save answers" stores nothing for it.
 */

const FACT = 'Can you work on site one day a week?'
const PROSE = 'Why do you want this role?'
const GAP = 'Whether you can work on site one day a week.'
const FACT_DRAFT = 'Nothing I stored says whether I can work on site one day a week.'
const PROSE_DRAFT = 'I like the work Acme does on the analytical engine.'
const FLAGGED = 'I live in London.'

interface Reply { draft: string; missing?: string; unsupportedClaims?: string[] }

const PAGE: EnumField[] = [
  field(0, FACT, { kind: 'text' }),
  field(1, PROSE, { kind: 'textarea' }),
]
const mappingFor = (fields: EnumField[]): Resolution[] =>
  fields.map((f) => resolution(f, { fieldClass: f.label === PROSE ? 'prose' : 'personal_fact' }))

const host = installHeldMappingHost()
/** question → what the next generate request for it answers. */
let replies: Record<string, Reply>
let saves: SaveItem[][]

beforeEach(() => {
  replies = { [FACT]: { draft: FACT_DRAFT, missing: GAP }, [PROSE]: { draft: PROSE_DRAFT } }
  saves = []
  host.fields = PAGE
  host.mappingFor = mappingFor
  const base = window.__jffHostBridge!
  window.__jffHostBridge = async (req): Promise<HostResponse> => {
    if (req.method === 'generate') {
      const q = (req.params as { questionRaw: string }).questionRaw
      return { requestId: req.requestId, ok: true, result: { model: 'claude-test-writer', ...replies[q] } }
    }
    if (req.method === 'save') {
      saves.push((req.params as { items: SaveItem[] }).items)
      return { requestId: req.requestId, ok: true, result: { saved: saves.at(-1)!.length } }
    }
    return await base(req)
  }
})

const editor = (label: string): HTMLInputElement | HTMLTextAreaElement =>
  screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement
const lineIn = (label: string): Element | null => rowOf(label)?.querySelector('[data-jff-draft-missing]') ?? null
const sessionRow = (): Session | undefined => host.storage['jff:session:7'] as Session | undefined

async function scanned(): Promise<ReturnType<typeof render>> {
  const view = render(<App />)
  await waitFor(() => { expect(host.held).toHaveLength(1) })
  await release(host, (h) => mapped(host, h))
  await waitFor(() => { expect(rowLabels()).toHaveLength(PAGE.length) })
  await waitFor(() => { expect(status()).toBe('done') })
  return view
}

async function generate(label: string): Promise<void> {
  fireEvent.click(within(rowOf(label) as HTMLElement).getByRole('button', { name: 'Generate with AI' }))
  await waitFor(() => { expect(editor(label).value).toBe(replies[label]!.draft) })
}

/** Another Scan of the tab, with Mapping released, over the Fields `host.fields` holds now. */
async function rescan(): Promise<void> {
  const before = host.held.length
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
  await waitFor(() => { expect(host.held.length).toBe(before + 1) })
  await release(host, (h) => mapped(host, h))
  await waitFor(() => { expect(rowLabels()).toHaveLength(host.fields.length) })
  await waitFor(() => { expect(status()).toBe('done') })
}

async function saveAnswers(): Promise<SaveItem[]> {
  const before = saves.length
  fireEvent.click(screen.getByRole('button', { name: 'Save answers' }))
  await waitFor(() => { expect(saves.length).toBe(before + 1) })
  return saves.at(-1)!
}

describe('A Draft that names a gap', () => {
  it('shows the gap above the Draft\'s editor, with the Draft editable and its Fill button enabled', async () => {
    await scanned()
    await generate(FACT)
    const line = lineIn(FACT)
    expect(line).not.toBeNull()
    expect(line!.textContent).toContain(GAP)
    expect(line!.compareDocumentPosition(editor(FACT)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const fill = within(rowOf(FACT) as HTMLElement).getByRole('button', { name: 'Fill' }) as HTMLButtonElement
    expect(fill.disabled).toBe(false)
    fireEvent.click(fill)
    await waitFor(() => { expect(host.page[0]).toBe(FACT_DRAFT) })
  })

  it('shows it for a Prose Field too', async () => {
    replies[PROSE] = { draft: PROSE_DRAFT, missing: 'Which of your projects matches the role.' }
    await scanned()
    await generate(PROSE)
    expect(lineIn(PROSE)?.textContent).toContain('Which of your projects matches the role.')
  })

  it('shows no line for a reply without a gap, on a Prose Field and on a Personal-fact Field', async () => {
    replies[FACT] = { draft: 'Yes, I can.' }
    await scanned()
    await generate(FACT)
    await generate(PROSE)
    expect(lineIn(FACT)).toBeNull()
    expect(lineIn(PROSE)).toBeNull()
    expect(document.querySelector('[data-jff-draft-missing]')).toBeNull()
  })

  it('goes when the user changes the row\'s text', async () => {
    await scanned()
    await generate(FACT)
    fireEvent.change(editor(FACT), { target: { value: 'Yes, on Tuesdays.' } })
    expect(editor(FACT).value).toBe('Yes, on Tuesdays.')
    expect(lineIn(FACT)).toBeNull()
  })

  it('is cleared by a new Draft with no gap, and replaced by a new Draft with another', async () => {
    await scanned()
    await generate(FACT)
    replies[FACT] = { draft: FACT_DRAFT, missing: 'Which weekday suits you.' }
    await generate(FACT)
    await waitFor(() => { expect(lineIn(FACT)?.textContent).toContain('Which weekday suits you.') })
    expect(lineIn(FACT)!.textContent).not.toContain(GAP)
    replies[FACT] = { draft: FACT_DRAFT }
    await generate(FACT)
    await waitFor(() => { expect(lineIn(FACT)).toBeNull() })
  })

  it('shows beside the Draft check\'s warning, each on its own', async () => {
    replies[FACT] = { draft: `${FACT_DRAFT} ${FLAGGED}`, missing: GAP, unsupportedClaims: [FLAGGED] }
    await scanned()
    await generate(FACT)
    const row = rowOf(FACT)!
    expect(row.querySelector('[data-jff-draft-warning]')?.textContent).toContain(FLAGGED)
    expect(lineIn(FACT)?.textContent).toContain(GAP)
  })

  it('is still there after another Scan of the same page', async () => {
    await scanned()
    await generate(FACT)
    await rescan()
    expect(editor(FACT).value).toBe(FACT_DRAFT)
    expect(lineIn(FACT)?.textContent).toContain(GAP)
  }, 15_000)

  it('is still there after a wizard step that shows the same question again', async () => {
    await scanned()
    await generate(FACT)
    host.fields = [field(0, 'Your portfolio link', { kind: 'text' }), field(1, FACT, { kind: 'text' })]
    await rescan()
    expect(editor(FACT).value).toBe(FACT_DRAFT)
    expect(lineIn(FACT)?.textContent).toContain(GAP)
  }, 15_000)

  it('is still there after a reload of the Side panel', async () => {
    const first = await scanned()
    await generate(FACT)
    await waitFor(() => { expect(Object.values(sessionRow()?.answers ?? {}).some((a) => a.draft?.missing === GAP)).toBe(true) }, { timeout: 3_000 })
    first.unmount()
    render(<App />)
    await waitFor(() => { expect(lineIn(FACT)?.textContent).toContain(GAP) }, { timeout: 8_000 })
    expect(editor(FACT).value).toBe(FACT_DRAFT)
  }, 20_000)
})

describe('"Save answers" and a Draft that names a gap', () => {
  it('stores nothing for a row whose text is that Draft, including after another Scan', async () => {
    await scanned()
    await generate(FACT)
    await generate(PROSE)
    expect((await saveAnswers()).map((it) => it.questionRaw)).toEqual([PROSE])
    await rescan()
    expect((await saveAnswers()).map((it) => it.questionRaw)).toEqual([PROSE])
  }, 15_000)

  it('stores the row once the user changed its text in the Side panel', async () => {
    await scanned()
    await generate(FACT)
    fireEvent.change(editor(FACT), { target: { value: 'Yes, on Tuesdays.' } })
    const items = await saveAnswers()
    expect(items).toEqual([expect.objectContaining({ questionRaw: FACT, answer: 'Yes, on Tuesdays.' })])
  })
})
