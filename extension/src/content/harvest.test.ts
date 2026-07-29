import { describe, it, expect } from 'vitest'
import { attributableListbox, harvestOptions } from './harvest'

function mountCombobox(html: string): HTMLInputElement {
  document.body.innerHTML = html
  const el = document.querySelector<HTMLInputElement>('[role="combobox"]')!
  el.setAttribute('data-jff-fid', '0')
  return el
}

/** Ashby-style lazy listbox: mounted into the wrapper on click. */
function clickMountsListbox(el: HTMLElement, texts: string[]): void {
  el.addEventListener('click', () => {
    if (el.parentElement!.querySelector('[role="listbox"]') !== null) return
    const lb = document.createElement('ul')
    lb.setAttribute('role', 'listbox')
    for (const t of texts) {
      const o = document.createElement('li')
      o.setAttribute('role', 'option')
      o.textContent = t
      lb.appendChild(o)
    }
    el.parentElement!.appendChild(lb)
  })
}

describe('harvestOptions', () => {
  it('reads options from a listbox that appears in response to the click', async () => {
    const el = mountCombobox('<div><input role="combobox"></div>')
    clickMountsListbox(el, ['Brazil', 'Portugal'])
    await expect(harvestOptions(document, [0])).resolves.toEqual({ 0: ['Brazil', 'Portugal'] })
  })

  it('uses the aria-controls listbox even when it was mounted before the click', async () => {
    document.body.innerHTML = `
      <input role="combobox" aria-controls="lb1" data-jff-fid="0">
      <ul role="listbox" id="lb1"><li role="option">Alpha</li><li role="option">Beta</li></ul>`
    await expect(harvestOptions(document, [0])).resolves.toEqual({ 0: ['Alpha', 'Beta'] })
  })

  it("never reads another control's pre-existing, unattributed listbox", async () => {
    document.body.innerHTML = `
      <div><input role="combobox" data-jff-fid="0"></div>
      <ul role="listbox"><li role="option">Not yours</li></ul>`
    await expect(harvestOptions(document, [0])).resolves.toEqual({ 0: [] })
  }, 10_000) // runs the real 500ms attribution timeout

  it('restores a pre-set value that the open/close mutated — never clears it', async () => {
    const el = mountCombobox('<div><input role="combobox" value="São Paulo"></div>')
    clickMountsListbox(el, ['A', 'B'])
    el.addEventListener('click', () => { el.value = 'clobbered-by-open' })
    await harvestOptions(document, [0])
    expect(el.value).toBe('São Paulo')
  })

  it('leaves an untouched value identical, with zero synthetic input events', async () => {
    const el = mountCombobox('<div><input role="combobox" value="Kept"></div>')
    clickMountsListbox(el, ['A'])
    let inputEvents = 0
    el.addEventListener('input', () => { inputEvents++ })
    await harvestOptions(document, [0])
    expect(el.value).toBe('Kept')
    expect(inputEvents).toBe(0)
  })

  it('closes via Escape so the page can retract its listbox', async () => {
    const el = mountCombobox('<div><input role="combobox"></div>')
    clickMountsListbox(el, ['A'])
    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') el.parentElement!.querySelector('[role="listbox"]')?.remove()
    })
    await harvestOptions(document, [0])
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  it('answers [] for a missing fid and for a non-combobox control', async () => {
    document.body.innerHTML = '<input type="text" data-jff-fid="3">'
    await expect(harvestOptions(document, [3, 99])).resolves.toEqual({ 3: [], 99: [] })
  })

  it('harvests a combobox inside an OPEN SHADOW ROOT (ids resolve in its own scope)', async () => {
    // `elementByFid` already pierces open shadow roots (walkElements); the
    // attribution lookup must too, or a shadow widget silently harvests nothing.
    document.body.innerHTML = '<my-combo></my-combo>'
    const shadow = document.querySelector('my-combo')!.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <input role="combobox" data-jff-fid="0" aria-controls="lb-s">
      <ul role="listbox" id="lb-s"><li role="option">Alpha</li><li role="option">Beta</li></ul>`
    await expect(harvestOptions(document, [0])).resolves.toEqual({ 0: ['Alpha', 'Beta'] })
  })
})

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
