import { describe, it, expect } from 'vitest'
import { attributableListbox } from './listbox'

describe('attributableListbox', () => {
  it('prefers aria-owns over an appeared listbox', () => {
    document.body.innerHTML = `
      <input role="combobox" aria-owns="mine">
      <ul role="listbox" id="mine"></ul>
      <ul role="listbox" id="other"></ul>`
    const el = document.querySelector('[role="combobox"]')!
    expect(attributableListbox(document, el, new Set())).toBe(document.getElementById('mine'))
  })

  it('falls back ONLY to a listbox absent from the before-set (no document-wide fallback)', () => {
    document.body.innerHTML = '<input role="combobox"><ul role="listbox" id="old"></ul>'
    const el = document.querySelector('[role="combobox"]')!
    const old = document.getElementById('old')!
    expect(attributableListbox(document, el, new Set([old]))).toBeNull()
    const fresh = document.createElement('ul')
    fresh.setAttribute('role', 'listbox')
    document.body.appendChild(fresh)
    expect(attributableListbox(document, el, new Set([old]))).toBe(fresh)
  })
})
