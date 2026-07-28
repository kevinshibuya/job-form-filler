import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setNativeValue, fillOne, fillFields, fillFile } from './fill'
import { enumerateFields, type MeasureFn } from './enumerate'

/**
 * jsdom has never implemented the DataTransfer API (jsdom/jsdom#1568, still open),
 * so `new DataTransfer()` throws ReferenceError in this test environment even
 * though it is standard and correct in the real Chrome runtime this content
 * script actually ships to. Guarding on `typeof DataTransfer === 'undefined'`
 * means this shim is inert in a real browser (fillFile.ts is exercised
 * unmodified against real DataTransfer there) and only patches the jsdom gap
 * here: a minimal DataTransfer + an input.files setter that accepts a plain
 * array, since jsdom's real `files` setter requires an internally-constructed
 * FileList that no public API can produce.
 */
if (typeof globalThis.DataTransfer === 'undefined') {
  class FakeDataTransfer {
    private _files: File[] = []
    items = { add: (f: File): void => { this._files.push(f) } }
    get files(): FileList { return this._files as unknown as FileList }
  }
  ;(globalThis as unknown as { DataTransfer: unknown }).DataTransfer = FakeDataTransfer

  const proto = HTMLInputElement.prototype
  const native = Object.getOwnPropertyDescriptor(proto, 'files')!
  const shadow = new WeakMap<HTMLInputElement, File[]>()
  Object.defineProperty(proto, 'files', {
    configurable: true,
    enumerable: native.enumerable,
    get(this: HTMLInputElement) { return shadow.get(this) ?? native.get!.call(this) },
    set(this: HTMLInputElement, v: unknown) {
      if (Array.isArray(v)) { shadow.set(this, v); return }
      native.set!.call(this, v)
    },
  })
}

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 100, height: 20 })
beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('setNativeValue', () => {
  it('bypasses a framework-shadowed instance setter and writes the real value', () => {
    document.body.innerHTML = '<input id="x">'
    const el = document.getElementById('x') as HTMLInputElement
    // Simulate React shadowing the instance value accessor.
    let shadowed = ''
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () => shadowed,
      set: (v: string) => { shadowed = `shadowed:${v}` },
    })
    setNativeValue(el, 'kevin')
    expect(shadowed).toBe('') // the instance setter was never called
    delete (el as unknown as Record<string, unknown>).value // drop the shadow
    expect(el.value).toBe('kevin') // the native value really changed
  })

  it('dispatches bubbling input and change events', () => {
    document.body.innerHTML = '<form><input id="x"></form>'
    const el = document.getElementById('x') as HTMLInputElement
    const seen: string[] = []
    document.querySelector('form')!.addEventListener('input', () => seen.push('input'))
    document.querySelector('form')!.addEventListener('change', () => seen.push('change'))
    setNativeValue(el, 'kevin')
    expect(seen).toEqual(['input', 'change'])
    expect(el.value).toBe('kevin')
  })
})

describe('fillOne', () => {
  it('fills a text input', async () => {
    document.body.innerHTML = '<input id="x">'
    await expect(fillOne(document.getElementById('x')!, 'Kevin')).resolves.toEqual({ ok: true })
    expect((document.getElementById('x') as HTMLInputElement).value).toBe('Kevin')
  })

  it('fills a textarea', async () => {
    document.body.innerHTML = '<textarea id="x"></textarea>'
    await fillOne(document.getElementById('x')!, 'long answer')
    expect((document.getElementById('x') as HTMLTextAreaElement).value).toBe('long answer')
  })

  it('selects a native select option by VISIBLE LABEL', async () => {
    document.body.innerHTML = '<select id="s"><option value=""></option><option value="y">I am authorized</option></select>'
    await fillOne(document.getElementById('s')!, 'I am authorized')
    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('y')
  })

  it('falls back to matching a select option by VALUE', async () => {
    document.body.innerHTML = '<select id="s"><option value=""></option><option value="yes">Sim</option></select>'
    await fillOne(document.getElementById('s')!, 'yes')
    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('yes')
  })

  it('reports a failure when no select option matches', async () => {
    document.body.innerHTML = '<select id="s"><option value="a">A</option></select>'
    await expect(fillOne(document.getElementById('s')!, 'Z')).resolves.toMatchObject({ ok: false, reason: 'no-matching-option' })
  })

  it('CLICKS the matching radio rather than assigning a value', async () => {
    document.body.innerHTML = `
      <label><input type="radio" name="wm" value="r"> Remote</label>
      <label><input type="radio" name="wm" value="h"> Hybrid</label>`
    const clicked: string[] = []
    for (const r of Array.from(document.querySelectorAll('input'))) {
      r.addEventListener('click', () => clicked.push((r as HTMLInputElement).value))
    }
    await fillOne(document.querySelector('input')!, 'Hybrid')
    expect(clicked).toEqual(['h'])
    expect((document.querySelector('input[value="h"]') as HTMLInputElement).checked).toBe(true)
  })

  it('toggles a checkbox by clicking, only when the state must change', async () => {
    document.body.innerHTML = '<input type="checkbox" id="c">'
    const el = document.getElementById('c') as HTMLInputElement
    const clicks = vi.fn()
    el.addEventListener('click', clicks)
    await fillOne(el, 'true')
    expect(el.checked).toBe(true)
    await fillOne(el, 'true') // already correct: must NOT click again
    expect(clicks).toHaveBeenCalledTimes(1)
    await fillOne(el, 'false')
    expect(el.checked).toBe(false)
  })

  it('opens an ARIA combobox and clicks the matching option', async () => {
    document.body.innerHTML = `
      <div id="c" role="combobox" aria-controls="lb" aria-expanded="false"></div>
      <div id="lb" role="listbox"><div role="option">Brazil</div><div role="option">Portugal</div></div>`
    const combo = document.getElementById('c')!
    combo.addEventListener('click', () => combo.setAttribute('aria-expanded', 'true'))
    const picked: string[] = []
    for (const o of Array.from(document.querySelectorAll('[role="option"]'))) {
      o.addEventListener('click', () => picked.push(o.textContent ?? ''))
    }
    await expect(fillOne(combo, 'Portugal')).resolves.toEqual({ ok: true })
    expect(picked).toEqual(['Portugal'])
  })

  it('reports a failure when the combobox has no matching option', async () => {
    document.body.innerHTML = `
      <div id="c" role="combobox" aria-controls="lb"></div>
      <div id="lb" role="listbox"><div role="option">Brazil</div></div>`
    await expect(fillOne(document.getElementById('c')!, 'Nowhere')).resolves.toMatchObject({ ok: false, reason: 'no-matching-option' })
  })

  it('never clicks a submit control', async () => {
    document.body.innerHTML = '<button id="b" type="submit">Submit</button>'
    await expect(fillOne(document.getElementById('b')!, 'x')).resolves.toMatchObject({ ok: false, reason: 'unsupported-widget' })
  })
})

describe('fillFile', () => {
  it('sets input.files through a DataTransfer and fires change', () => {
    document.body.innerHTML = '<input type="file" id="cv">'
    const el = document.getElementById('cv') as HTMLInputElement
    const changed = vi.fn()
    el.addEventListener('change', changed)
    const file = new File(['pdf bytes'], 'kevin-cv.pdf', { type: 'application/pdf' })
    expect(fillFile(el, file)).toEqual({ ok: true })
    expect(el.files?.[0]?.name).toBe('kevin-cv.pdf')
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

describe('fillFields', () => {
  it('resolves handles by fid and reports filled vs failed', async () => {
    document.body.innerHTML = `
      <label for="a">A</label><input id="a">
      <label for="s">S</label><select id="s"><option value="x">X</option></select>`
    enumerateFields({ root: document, epoch: 4, measure: allVisible })
    const report = await fillFields(document, [
      { handle: { frameId: 0, fid: 0, epoch: 4 }, value: 'hello' },
      { handle: { frameId: 0, fid: 1, epoch: 4 }, value: 'NOPE' },
      { handle: { frameId: 0, fid: 99, epoch: 4 }, value: 'gone' },
    ])
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('hello')
    expect(report.filled).toEqual([{ frameId: 0, fid: 0, epoch: 4 }])
    expect(report.failed.map((f) => f.reason)).toEqual(['no-matching-option', 'element-not-found'])
  })
})
