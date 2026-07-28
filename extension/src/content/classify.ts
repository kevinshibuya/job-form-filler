import { defaultMeasure, type MeasureFn } from './enumerate'

export const DEMOGRAPHIC_RE =
  /eeo|equal employment|demographic|voluntary self|self-identif|veteran status|disability status|race\s*\/?\s*ethnicity|gender identity|autodeclara|raça|etnia|deficiência/i

const MAX_LEVELS = 5

function containerSignal(el: Element): string {
  const heading = Array.from(el.children)
    .filter((c) => /^(LEGEND|H1|H2|H3|H4|H5|H6)$/.test(c.tagName))
    .map((c) => c.textContent ?? '')
    .join(' ')
  return [el.id, el.className, el.getAttribute('aria-label') ?? '', heading].join(' ')
}

function isContainer(el: Element): boolean {
  return el.tagName === 'FIELDSET' || el.tagName === 'SECTION' || el.getAttribute('role') === 'group'
}

/**
 * EEO/demographic detection, EXACT rule:
 *   walk UP from the field, at most 5 levels, testing ONLY fieldset / section /
 *   [role="group"] containers, hard-stop at the <form>, and NEVER look at
 *   document.body or document.documentElement. Checking body-level headings is
 *   precisely the page-global taint bug job-finder documented.
 *
 * Cross-frame attribution: an EEO section is often an iframe whose OWNING element
 * carries the signal, which the child frame cannot read. When we are in a subframe
 * we additionally test the frame's own title and URL, and `window.frameElement`
 * when the frame is same-origin (srcdoc frames are).
 */
export function isDemographic(el: Element, opts: { isSubframe?: boolean } = {}): boolean {
  const form = el.closest('form')
  let node: Element | null = el.parentElement
  let levels = 0

  while (node !== null && levels < MAX_LEVELS) {
    // `break`, never `return false`: body/documentElement are not consulted as
    // containers, but control must still FALL THROUGH to the subframe heuristics
    // below — inside an EEO srcdoc iframe the field's parent often IS <body>.
    if (node === document.body || node === document.documentElement) break
    if (isContainer(node) && DEMOGRAPHIC_RE.test(containerSignal(node))) return true
    if (node === form) break // hard stop: never climb past the form
    node = node.parentElement
    levels++
  }

  const isSubframe = opts.isSubframe ?? (window.top !== window.self)
  if (isSubframe) {
    if (DEMOGRAPHIC_RE.test(document.title)) return true
    if (DEMOGRAPHIC_RE.test(location.href)) return true
    try {
      const owner = window.frameElement
      if (owner !== null) {
        const sig = [owner.id, owner.className, owner.getAttribute('title') ?? '', owner.getAttribute('aria-label') ?? ''].join(' ')
        if (DEMOGRAPHIC_RE.test(sig)) return true
      }
    } catch {
      // cross-origin parent: frameElement throws. Title/URL above is our best signal.
    }
  }

  return false
}

const ACTIVE_CAPTCHA_SELECTORS = [
  '.g-recaptcha',
  'iframe[src*="recaptcha/api2/anchor"]',
  'iframe[src*="recaptcha/enterprise/anchor"]',
  'iframe[src*="hcaptcha"]',
  '[data-sitekey]',
  '#challenge-form',
].join(',')

/**
 * ACTIVE challenge only. The passive badge Greenhouse renders on nearly every form
 * (`.grecaptcha-badge`) and zero-sized invisible reCAPTCHA containers are NOT
 * blockers; treating them as blockers would disable the tool everywhere.
 */
export function hasActiveCaptcha(root: Document, measure: MeasureFn = defaultMeasure): boolean {
  for (const el of Array.from(root.querySelectorAll(ACTIVE_CAPTCHA_SELECTORS))) {
    if (el.closest('.grecaptcha-badge') !== null) continue
    if (el.getAttribute('data-size') === 'invisible') continue
    const m = measure(el)
    if (m.display === 'none' || m.visibility === 'hidden' || m.ariaHidden) continue
    if (m.width < 100 || m.height < 50) continue
    return true
  }
  return false
}
