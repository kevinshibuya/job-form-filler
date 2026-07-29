import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setNativeValue, fillOne, fillFields, fillFile } from './fill'
import { enumerateFields, type MeasureFn } from './enumerate'
import {
  ASHBY_CHOICE_RADIO, ASHBY_YESNO_EN, ASHBY_YESNO_PT, CHOICE_FORM_WRAPPED,
  CHOICE_RADIO_OPAQUE_VALUES, CHOICE_SUBMIT_WORDED, STYLED_HIDDEN_CHECKBOX, TWO_OPEN_COMBOBOX,
} from './fixtures/ashby'

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

const allVisible: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 100, height: 20, clipped: false })
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
      o.addEventListener('click', () => { combo.textContent = o.textContent })
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

/** Wire click spies on every option button in the current DOM. */
function spyButtons(): { clicks: string[]; buttons: HTMLButtonElement[] } {
  const clicks: string[] = []
  const buttons = Array.from(document.querySelectorAll('button'))
  for (const b of buttons) b.addEventListener('click', () => clicks.push((b.textContent ?? '').trim()))
  return { clicks, buttons }
}

/** Ashby-like controlled checkbox: the page ignores direct input clicks and
 *  drives all state from the buttons. */
function controlCheckbox(): HTMLInputElement {
  const cb = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  cb.addEventListener('click', (e) => e.preventDefault())
  return cb
}

/** Page behavior for the buttons: clicking one marks it aria-pressed. */
function pressableButtons(): void {
  for (const b of Array.from(document.querySelectorAll('button'))) {
    b.addEventListener('click', () => {
      for (const s of Array.from(b.parentElement!.querySelectorAll('button'))) {
        s.setAttribute('aria-pressed', String(s === b))
      }
    })
  }
}

describe('fillOne — choice widgets (B1)', () => {
  it('radio-backed: clicks the value-matching member radio, zero button clicks', async () => {
    document.body.innerHTML = ASHBY_CHOICE_RADIO
    const { clicks } = spyButtons()
    const first = document.querySelector<HTMLInputElement>('input[type="radio"]')!
    await expect(fillOne(first, 'No')).resolves.toEqual({ ok: true })
    expect(document.querySelector<HTMLInputElement>('input[value="no"]')!.checked).toBe(true)
    expect(clicks).toEqual([])
  })

  it('radio-backed with opaque values: answers through the ungated button (fillRadioGroup could not)', async () => {
    document.body.innerHTML = CHOICE_RADIO_OPAQUE_VALUES
    pressableButtons()
    const { clicks } = spyButtons()
    const first = document.querySelector<HTMLInputElement>('input[type="radio"]')!
    await expect(fillOne(first, 'Não')).resolves.toEqual({ ok: true })
    // Proof it routed through fillChoice BEFORE the radio branch: the radios'
    // values (opt_0/opt_1) match neither 'Não' nor any option label, so
    // fillRadioGroup would have answered no-matching-option. Nothing NAMES the
    // option on the input side, so step 1 is skipped (index alignment is not a
    // step-1 candidate) and the ungated button carries the answer.
    expect(clicks).toEqual(['Não'])
    expect(document.querySelectorAll('button')[1]!.getAttribute('aria-pressed')).toBe('true')
  })

  it('falls back to index alignment ONLY after the button gate refuses', async () => {
    // Untyped buttons inside a <form> fail gate (c); with no nameable member
    // radio, index alignment is the last thing left before asking the user.
    document.body.innerHTML = `
      <form action="/apply">
        <div class="_container_1svni_28 _yesno_1e3gg_148">
          <button class="_option_1svni_32">Sim</button>
          <button class="_option_1svni_32">Não</button>
          <input type="radio" class="_input_1svni_78" name="ix-uuid" value="opt_0">
          <input type="radio" class="_input_1svni_78" name="ix-uuid" value="opt_1">
        </div>
      </form>`
    const { clicks } = spyButtons()
    const first = document.querySelector<HTMLInputElement>('input[type="radio"]')!
    await expect(fillOne(first, 'Não')).resolves.toEqual({ ok: true })
    expect(document.querySelector<HTMLInputElement>('input[value="opt_1"]')!.checked).toBe(true)
    expect(clicks).toEqual([]) // the in-form button was never clicked
  })

  it('checkbox-backed, click-accepting: fills affirmative with ZERO button clicks', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const { clicks } = spyButtons()
    const cb = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await expect(fillOne(cb, 'Yes')).resolves.toEqual({ ok: true })
    expect(cb.checked).toBe(true)
    expect(clicks).toEqual([])
  })

  it('checkbox-backed, controlled input: falls through to the matching button', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const cb = controlCheckbox()
    pressableButtons()
    const { clicks } = spyButtons()
    await expect(fillOne(cb, 'Yes')).resolves.toEqual({ ok: true })
    expect(cb.checked).toBe(false) // the input click was prevented; the button carried the answer
    expect(clicks).toEqual(['Yes'])
    expect(document.querySelectorAll('button')[0]!.getAttribute('aria-pressed')).toBe('true')
  })

  it('filling "No" on an unchecked controlled box NEVER silently no-ops: the button is clicked', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    const cb = controlCheckbox()
    pressableButtons()
    const { clicks } = spyButtons()
    await expect(fillOne(cb, 'No')).resolves.toEqual({ ok: true })
    expect(clicks).toEqual(['No'])
    expect(document.querySelectorAll('button')[1]!.getAttribute('aria-pressed')).toBe('true')
  })

  it('matches i18n option texts verbatim (Não), never boolean-mapped', async () => {
    document.body.innerHTML = ASHBY_YESNO_PT
    controlCheckbox()
    pressableButtons()
    const { clicks } = spyButtons()
    await expect(fillOne(document.querySelector('input[type="checkbox"]')!, 'Não')).resolves.toEqual({ ok: true })
    expect(clicks).toEqual(['Não'])
  })

  it('never clicks an untyped button inside a <form>', async () => {
    document.body.innerHTML = CHOICE_FORM_WRAPPED
    const cb = controlCheckbox() // step 1 is prevented, so only the gate stands between us and the button
    const { clicks } = spyButtons()
    await expect(fillOne(cb, 'Yes')).resolves.toEqual({ ok: false, reason: 'choice-needs-user-click' })
    expect(clicks).toEqual([])
  })

  it('refuses a submit-worded button even with NO <form> on the page', async () => {
    document.body.innerHTML = CHOICE_SUBMIT_WORDED
    const { clicks } = spyButtons()
    await expect(fillOne(document.querySelector('input[type="checkbox"]')!, 'Enviar'))
      .resolves.toEqual({ ok: false, reason: 'choice-needs-user-click' })
    expect(clicks).toEqual([])
  })

  it('answers choice-needs-user-click when no button matches the value', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    controlCheckbox()
    await expect(fillOne(document.querySelector('input[type="checkbox"]')!, 'Maybe'))
      .resolves.toEqual({ ok: false, reason: 'choice-needs-user-click' })
  })

  it('reports no-state-change when the clicked button produces no observable delta', async () => {
    document.body.innerHTML = ASHBY_YESNO_EN
    controlCheckbox() // inert buttons: no listeners, no attribute changes
    const { clicks } = spyButtons()
    await expect(fillOne(document.querySelector('input[type="checkbox"]')!, 'Yes'))
      .resolves.toEqual({ ok: false, reason: 'no-state-change' })
    expect(clicks).toEqual(['Yes']) // the click WAS attempted; success was not claimed without evidence
  })

  it('a styled hidden checkbox with no sibling buttons still takes the plain checkbox path', async () => {
    document.body.innerHTML = STYLED_HIDDEN_CHECKBOX
    const el = document.getElementById('tos-check') as HTMLInputElement
    // Correct no-op: unchecking an already-unchecked box reports ok, zero clicks.
    const clicks = vi.fn()
    el.addEventListener('click', clicks)
    await expect(fillOne(el, 'false')).resolves.toEqual({ ok: true })
    expect(clicks).not.toHaveBeenCalled()
  })
})

describe('fillCombobox — attribution, typeahead, restore (B2)', () => {
  it("never selects an option from another combobox's listbox", async () => {
    document.body.innerHTML = TWO_OPEN_COMBOBOX
    const otherOptions: string[] = []
    for (const o of Array.from(document.querySelectorAll('[role="option"]'))) {
      o.addEventListener('click', () => otherOptions.push(o.textContent ?? ''))
    }
    const a = document.getElementById('cb-a') as HTMLInputElement
    // cb-a owns no listbox and none appears for it: attribution fails, the fill
    // fails — and cb-b's mounted listbox is NEVER consulted (the old
    // document-wide fallback would have clicked 'Portuguese').
    await expect(fillOne(a, 'Portuguese')).resolves.toEqual({ ok: false, reason: 'no-matching-option' })
    expect(otherOptions).toEqual([])
    expect((document.getElementById('cb-b') as HTMLInputElement).value).toBe('')
  }, 10_000) // runs the real 500ms attribution window

  it('uses a listbox that appears in response to OUR click', async () => {
    document.body.innerHTML = '<div><input id="c" role="combobox"></div>'
    const el = document.getElementById('c') as HTMLInputElement
    el.addEventListener('click', () => {
      const lb = document.createElement('ul')
      lb.setAttribute('role', 'listbox')
      for (const t of ['Brazil', 'Portugal']) {
        const o = document.createElement('li')
        o.setAttribute('role', 'option')
        o.textContent = t
        o.addEventListener('click', () => setNativeValue(el, t))
        lb.appendChild(o)
      }
      el.parentElement!.appendChild(lb)
    })
    await expect(fillOne(el, 'Portugal')).resolves.toEqual({ ok: true })
    expect(el.value).toBe('Portugal')
  })

  it('types natively to filter when the target option is not mounted, then selects the EXACT match', async () => {
    document.body.innerHTML = `
      <div>
        <input id="c" role="combobox" aria-controls="lb">
        <ul role="listbox" id="lb"><li role="option">Brazil</li></ul>
      </div>`
    const el = document.getElementById('c') as HTMLInputElement
    const lb = document.getElementById('lb')!
    // The page's typeahead: re-render the options from the typed value.
    el.addEventListener('input', () => {
      lb.innerHTML = ''
      const o = document.createElement('li')
      o.setAttribute('role', 'option')
      o.textContent = 'Portugal'
      o.addEventListener('click', () => setNativeValue(el, 'Portugal'))
      lb.appendChild(o)
    })
    await expect(fillOne(el, 'Portugal')).resolves.toEqual({ ok: true })
    expect(el.value).toBe('Portugal')
  })

  it('rejects a prefix match and RESTORES the pre-fill value (prefix guessing removed)', async () => {
    document.body.innerHTML = `
      <div>
        <input id="c" role="combobox" aria-controls="lb" value="Lisbon">
        <ul role="listbox" id="lb"><li role="option">Portugal</li></ul>
      </div>`
    const el = document.getElementById('c') as HTMLInputElement
    const picked = vi.fn()
    document.querySelector('[role="option"]')!.addEventListener('click', picked)
    // Old behavior: 'Port' prefix-matched 'Portugal'. Now: no exact match, the
    // typeahead types 'Port', the page never mounts an exact option, and the
    // control comes back EXACTLY as it was — never cleared to ''.
    await expect(fillOne(el, 'Port')).resolves.toEqual({ ok: false, reason: 'no-matching-option' })
    expect(picked).not.toHaveBeenCalled()
    expect(el.value).toBe('Lisbon')
  }, 10_000) // runs the real post-typeahead 500ms window

  it('fails and restores when the page rejects the committed value', async () => {
    document.body.innerHTML = `
      <div>
        <input id="c" role="combobox" aria-controls="lb" value="Kept">
        <ul role="listbox" id="lb"><li role="option">Portugal</li></ul>
      </div>`
    const el = document.getElementById('c') as HTMLInputElement
    // The option click commits NOTHING (a controlled widget that ignored us).
    await expect(fillOne(el, 'Portugal')).resolves.toEqual({ ok: false, reason: 'no-matching-option' })
    expect(el.value).toBe('Kept')
  })

  it('closes the listbox via Escape on failure so no dropdown is left open', async () => {
    document.body.innerHTML = '<div><input id="c" role="combobox"></div>'
    const el = document.getElementById('c') as HTMLInputElement
    el.addEventListener('click', () => {
      if (el.parentElement!.querySelector('[role="listbox"]') !== null) return
      const lb = document.createElement('ul')
      lb.setAttribute('role', 'listbox')
      const o = document.createElement('li')
      o.setAttribute('role', 'option')
      o.textContent = 'Brazil'
      lb.appendChild(o)
      el.parentElement!.appendChild(lb)
    })
    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') el.parentElement!.querySelector('[role="listbox"]')?.remove()
    })
    await expect(fillOne(el, 'Nowhere')).resolves.toMatchObject({ ok: false })
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  }, 10_000)
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
    expect(report.filled).toEqual([{ handle: { frameId: 0, fid: 0, epoch: 4 }, committed: null }])
    expect(report.failed.map((f) => f.reason)).toEqual(['no-matching-option', 'element-not-found'])
  })
})
