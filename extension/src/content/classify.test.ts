import { describe, it, expect, beforeEach } from 'vitest'
import { isDemographic, hasActiveCaptcha } from './classify'
import type { MeasureFn } from './enumerate'

beforeEach(() => { document.documentElement.innerHTML = '<head></head><body></body>' })

describe('isDemographic', () => {
  it('flags a field inside a fieldset whose legend is an EEO heading', () => {
    document.body.innerHTML = `<form><fieldset><legend>Voluntary Self-Identification</legend><select id="g"></select></fieldset></form>`
    expect(isDemographic(document.getElementById('g')!)).toBe(true)
  })

  it('flags a field inside a section whose heading mentions demographics', () => {
    document.body.innerHTML = `<form><section><h2>Demographic Questions</h2><select id="g"></select></section></form>`
    expect(isDemographic(document.getElementById('g')!)).toBe(true)
  })

  it('flags a field inside a [role=group] whose aria-label mentions EEO', () => {
    document.body.innerHTML = `<form><div role="group" aria-label="EEO information"><select id="g"></select></div></form>`
    expect(isDemographic(document.getElementById('g')!)).toBe(true)
  })

  it('matches on the container id and class too', () => {
    document.body.innerHTML = `<form><section id="eeo-section"><select id="g"></select></section></form>`
    expect(isDemographic(document.getElementById('g')!)).toBe(true)
  })

  it('does NOT flag a normal field in the same form', () => {
    document.body.innerHTML = `<form><fieldset><legend>Voluntary Self-Identification</legend><select id="g"></select></fieldset>
      <div><label for="e">Email</label><input id="e"></div></form>`
    expect(isDemographic(document.getElementById('e')!)).toBe(false)
  })

  it('NEVER consults document.body — a body-level EEO heading must not taint the page', () => {
    document.body.innerHTML = `<h1>Voluntary Self-Identification of Disability</h1>
      <form><div><label for="e">Email</label><input id="e"></div></form>`
    expect(isDemographic(document.getElementById('e')!)).toBe(false)
  })

  it('hard-stops at the form element: an EEO section OUTSIDE the form does not taint fields inside it', () => {
    document.body.innerHTML = `<section id="eeo-wrapper"><form><div><label for="e">Email</label><input id="e"></div></form></section>`
    expect(isDemographic(document.getElementById('e')!)).toBe(false)
  })

  it('stops after 5 ancestor levels', () => {
    document.body.innerHTML = `<form><section><h2>Demographic Questions</h2>
      <div><div><div><div><div><div><select id="g"></select></div></div></div></div></div></div></section></form>`
    expect(isDemographic(document.getElementById('g')!)).toBe(false)
  })

  it('treats a subframe whose own title says EEO as demographic', () => {
    document.title = 'EEO'
    document.body.innerHTML = `<label for="g">Gender</label><select id="g"></select>`
    expect(isDemographic(document.getElementById('g')!, { isSubframe: true })).toBe(true)
  })

  it('does not use the frame title heuristic in the TOP frame', () => {
    document.title = 'Voluntary Self-Identification'
    document.body.innerHTML = `<form><label for="e">Email</label><input id="e"></form>`
    expect(isDemographic(document.getElementById('e')!, { isSubframe: false })).toBe(false)
  })
})

describe('hasActiveCaptcha', () => {
  const big: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 304, height: 78, clipped: false })
  const tiny: MeasureFn = () => ({ display: 'block', visibility: 'visible', ariaHidden: false, width: 0, height: 0, clipped: false })

  it('flags a visible reCAPTCHA v2 challenge widget', () => {
    document.body.innerHTML = `<div class="g-recaptcha" data-sitekey="x"></div>`
    expect(hasActiveCaptcha(document, big)).toBe(true)
  })

  it('flags a visible hCaptcha challenge iframe', () => {
    document.body.innerHTML = `<iframe src="https://hcaptcha.com/captcha/v1/challenge"></iframe>`
    expect(hasActiveCaptcha(document, big)).toBe(true)
  })

  it('IGNORES the passive reCAPTCHA badge present on nearly every Greenhouse form', () => {
    document.body.innerHTML = `<div class="grecaptcha-badge"><iframe src="https://google.com/recaptcha/api2/anchor"></iframe></div>`
    expect(hasActiveCaptcha(document, big)).toBe(false)
  })

  it('IGNORES a zero-sized recaptcha container (invisible reCAPTCHA)', () => {
    document.body.innerHTML = `<div class="g-recaptcha" data-size="invisible"></div>`
    expect(hasActiveCaptcha(document, tiny)).toBe(false)
  })

  it('returns false on a clean page', () => {
    document.body.innerHTML = `<form><input name="x"></form>`
    expect(hasActiveCaptcha(document, big)).toBe(false)
  })
})
