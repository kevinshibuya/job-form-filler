import { describe, it, expect, beforeEach, vi } from 'vitest'
import { snapshotValues, installSnapshotListeners } from './snapshot'
import { enumerateFields, type MeasureFn } from './enumerate'

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 100, height: 20, clipped: false })
beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('snapshotValues', () => {
  it('reads live values of every stamped field, keyed by fid', () => {
    document.body.innerHTML = `
      <label for="a">A</label><input id="a">
      <label for="t">T</label><textarea id="t"></textarea>
      <label for="s">S</label><select id="s"><option value="">-</option><option value="x">X</option></select>
      <label for="c">C</label><input type="checkbox" id="c">`
    enumerateFields({ root: document, epoch: 2, measure: allVisible })
    ;(document.getElementById('a') as HTMLInputElement).value = 'typed by hand'
    ;(document.getElementById('t') as HTMLTextAreaElement).value = 'long answer'
    ;(document.getElementById('s') as HTMLSelectElement).value = 'x'
    ;(document.getElementById('c') as HTMLInputElement).checked = true
    expect(snapshotValues(document)).toEqual({ 0: 'typed by hand', 1: 'long answer', 2: 'X', 3: 'true' })
  })

  it('omits fields that are still empty', () => {
    document.body.innerHTML = `<label for="a">A</label><input id="a"><label for="b">B</label><input id="b">`
    enumerateFields({ root: document, epoch: 1, measure: allVisible })
    ;(document.getElementById('b') as HTMLInputElement).value = 'only b'
    expect(snapshotValues(document)).toEqual({ 1: 'only b' })
  })

  it('reads values inside open shadow roots', () => {
    const hostEl = document.createElement('my-widget')
    document.body.appendChild(hostEl)
    hostEl.attachShadow({ mode: 'open' }).innerHTML = '<label for="s">S</label><input id="s">'
    enumerateFields({ root: document, epoch: 1, measure: allVisible })
    ;(hostEl.shadowRoot!.getElementById('s') as HTMLInputElement).value = 'shadow typed'
    expect(snapshotValues(document)).toEqual({ 0: 'shadow typed' })
  })
})

describe('installSnapshotListeners', () => {
  it('pushes a snapshot on submit, in the CAPTURE phase so a preventDefault cannot stop it', () => {
    document.body.innerHTML = `<form id="f"><label for="a">A</label><input id="a"></form>`
    enumerateFields({ root: document, epoch: 7, measure: allVisible })
    ;(document.getElementById('a') as HTMLInputElement).value = 'final'
    const push = vi.fn()
    const uninstall = installSnapshotListeners(document, push)
    // A bubble-phase listener that stops propagation must NOT suppress our capture listener.
    document.getElementById('f')!.addEventListener('submit', (e) => { e.stopPropagation(); e.preventDefault() })
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(push).toHaveBeenCalledWith({ epoch: 7, values: { 0: 'final' } })
    uninstall() // module-level install guard is shared across `it()` blocks in this file; release it
  })

  it('pushes a snapshot on beforeunload', () => {
    document.body.innerHTML = `<label for="a">A</label><input id="a">`
    enumerateFields({ root: document, epoch: 7, measure: allVisible })
    ;(document.getElementById('a') as HTMLInputElement).value = 'leaving'
    const push = vi.fn()
    const uninstall = installSnapshotListeners(document, push)
    window.dispatchEvent(new Event('beforeunload'))
    expect(push).toHaveBeenCalledWith({ epoch: 7, values: { 0: 'leaving' } })
    uninstall() // module-level install guard is shared across `it()` blocks in this file; release it
  })

  it('installs exactly once and the returned uninstall stops further pushes', () => {
    document.body.innerHTML = `<form id="f"><label for="a">A</label><input id="a" value="v"></form>`
    enumerateFields({ root: document, epoch: 1, measure: allVisible })
    const push = vi.fn()
    const uninstall = installSnapshotListeners(document, push)
    installSnapshotListeners(document, push) // second call must be a no-op
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true }))
    expect(push).toHaveBeenCalledTimes(1)
    uninstall()
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true }))
    expect(push).toHaveBeenCalledTimes(1)
  })
})
