import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import type { EnumField, HostResponse, Resolution } from '@jff/shared'
import { App } from './App'
import { field, installHeldMappingHost, mapped, release, resolution, rowLabels, rowOf, status } from './testing/heldMapping'

/**
 * The label each Generation request carries, at the panel seam: the App renders
 * against a fake Native host whose Mapping reply labels each Field it matched
 * to nothing, and the test reads the `generate` requests the panel sends. A row
 * Mapping left without a label is sent as a personal fact (spec #98).
 */

const WHY = 'Why do you want this role?'
const VERSIONS = 'Which versions of TypeScript have you worked with?'
const ONSITE = 'Can you be on site one day a week?'

const PAGE: EnumField[] = [
  field(0, WHY, { kind: 'textarea' }),
  field(1, VERSIONS, { kind: 'text' }),
  field(2, ONSITE, { kind: 'textarea' }),
]

const mappingFor = (fields: EnumField[]): Resolution[] => fields.map((f) => {
  if (f.fid === 0) return resolution(f, { fieldClass: 'prose' })
  if (f.fid === 1) return resolution(f, { fieldClass: 'personal_fact' })
  return resolution(f, {})
})

const EXPECTED: Record<string, string> = { [WHY]: 'prose', [VERSIONS]: 'personal_fact', [ONSITE]: 'personal_fact' }

const host = installHeldMappingHost()
let sent: { questionRaw: string; fieldClass?: unknown }[]

beforeEach(() => {
  host.fields = PAGE
  host.mappingFor = mappingFor
  sent = []
  const base = window.__jffHostBridge!
  window.__jffHostBridge = async (req): Promise<HostResponse> => {
    if (req.method === 'generate') {
      const p = req.params as { questionRaw: string; fieldClass?: unknown }
      sent.push(p)
      return { requestId: req.requestId, ok: true, result: { draft: `Draft for: ${p.questionRaw}` } }
    }
    return await base(req)
  }
})

async function mountMapped(): Promise<void> {
  render(<App />)
  await waitFor(() => { expect(host.held).toHaveLength(1) })
  await release(host, (h) => mapped(host, h))
  await waitFor(() => { expect(rowLabels()).toHaveLength(PAGE.length) })
  await waitFor(() => { expect(status()).toBe('done') })
}

const generateIn = (label: string) =>
  within(rowOf(label) as HTMLElement).getByRole('button', { name: 'Generate with AI' })

describe('A Generation request carries the row\'s label', () => {
  it('sends the label from the row\'s own button, and personal_fact for a row with no label', async () => {
    await mountMapped()
    for (const label of [WHY, VERSIONS, ONSITE]) {
      fireEvent.click(generateIn(label))
      await waitFor(() => { expect(sent.map((p) => p.questionRaw)).toContain(label) })
    }
    for (const p of sent) expect(p.fieldClass, p.questionRaw).toBe(EXPECTED[p.questionRaw])
  })

  it('sends the label of every row from Generate all remaining', async () => {
    await mountMapped()
    fireEvent.click(document.querySelector('[data-jff-generate-all] button')!)
    await waitFor(() => { expect(sent).toHaveLength(PAGE.length) })
    for (const p of sent) expect(p.fieldClass, p.questionRaw).toBe(EXPECTED[p.questionRaw])
  })
})
