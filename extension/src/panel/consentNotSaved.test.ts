import { describe, it, expect } from 'vitest'
import type { EnumField, Resolution } from '@jff/shared'
import { buildSaveItems } from './save'

// What Save answers stores is the list buildSaveItems returns: the panel sends
// exactly that to the host's `save` request.

const field = (fid: number, label: string, patch: Partial<EnumField> = {}): EnumField => ({
  frameId: 0, fid, epoch: 1, label, name: null, idAttr: null, kind: 'text',
  options: [], required: false, visible: true, currentValue: null, demographic: false, ...patch,
})
const needsInput = (fid: number, reason = 'custom'): Resolution => ({
  handle: { frameId: 0, fid, epoch: 1 }, tier: 'needs_input', value: null, source: null,
  key: null, answerId: null, reason,
})

describe('Save answers leaves a Consent checkbox out', () => {
  it('a ticked lone checkbox is left out of what Save answers stores', () => {
    const items = buildSaveItems({
      fields: [
        field(0, 'I agree Acme may store and process my personal data.', { kind: 'checkbox', required: true }),
        field(1, 'What is your favourite engine?'),
      ],
      resolutions: [needsInput(0, 'consent-checkbox'), needsInput(1)],
      panelEdits: {},
      snapshot: { '0:0': 'true', '0:1': 'The Analytical Engine' },
      company: 'Acme',
    })
    expect(items.map((i) => i.questionRaw)).toEqual(['What is your favourite engine?'])
  })

  it('an unticked lone checkbox is left out too, typed in the panel or not', () => {
    const items = buildSaveItems({
      fields: [field(0, 'Send me news about future roles.', { kind: 'checkbox' })],
      resolutions: [needsInput(0, 'consent-checkbox')],
      panelEdits: { '0:0': 'false' },
      snapshot: {},
      company: 'Acme',
    })
    expect(items).toEqual([])
  })

  it('a checkbox drawn as yes/no buttons is a choice, not a Consent checkbox, and is still saved', () => {
    const items = buildSaveItems({
      fields: [field(0, 'Are you based in US or Canada?', { kind: 'choice', options: ['Yes', 'No'] })],
      resolutions: [needsInput(0)],
      panelEdits: {},
      snapshot: { '0:0': 'No' },
      company: 'Acme',
    })
    expect(items.map((i) => [i.questionRaw, i.answer])).toEqual([['Are you based in US or Canada?', 'No']])
  })
})
