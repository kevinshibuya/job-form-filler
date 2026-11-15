import { DEMOGRAPHIC_RE } from './dom'
import { defaultMeasure, type MeasureFn } from './enumerate'

// DEMOGRAPHIC_RE now lives in dom.ts (the leaf of the content-layer import
// graph) so the label heuristics can use it without a cycle. Re-exported here so
// every existing `from './classify'` import keeps resolving.
export { DEMOGRAPHIC_RE } from './dom'

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

function isHeading(el: Element): boolean {
  return /^(LEGEND|H1|H2|H3|H4|H5|H6)$/.test(el.tagName) || el.getAttribute('role') === 'heading'
}

/**
 * The heading a field sits under when its section is a plain container: the
 * nearest heading among the EARLIER siblings of the field and of each of its
 * ancestors. The hosted Greenhouse form lays its self-identification section
 * out this way, an <h3> beside the field wrappers, far above the inputs.
 *
 * The nearest heading decides, so a field under a later, ordinary heading never
 * inherits an earlier demographic one, and nothing before the heading does
 * either. Like the container walk it stops at the form and never reads the
 * children of document.body, but it has NO level cap: the Greenhouse heading
 * sits more than MAX_LEVELS above its inputs (pinned by the hosted fixture). On
 * a page with no <form> it may climb as high as a child of body.
 */
function sectionHeading(el: Element, form: Element | null): Element | null {
  let child: Element = el
  let node: Element | null = el.parentElement
  while (node !== null && node !== document.body && node !== document.documentElement) {
    for (let s = child.previousElementSibling; s !== null; s = s.previousElementSibling) {
      if (isHeading(s)) return s
    }
    if (node === form) break
    child = node
    node = node.parentElement
  }
  return null
}

/**
 * EEO/demographic detection, EXACT rule:
 *   walk UP from the field, at most 5 levels, testing ONLY fieldset / section /
 *   [role="group"] containers, hard-stop at the <form>, and NEVER look at
 *   document.body or document.documentElement. Checking body-level headings is
 *   precisely the page-global taint bug job-finder documented.
 *   Then the field's section heading (sectionHeading): the same form and body
 *   limits, with no level cap.
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

  const heading = sectionHeading(el, form)
  if (heading !== null && DEMOGRAPHIC_RE.test(heading.textContent ?? '')) return true

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
