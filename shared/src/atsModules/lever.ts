import type { AtsModule, ModuleLabel, PostingPage } from '../atsModule.js'

/** Every Control a question block can hold. Hidden inputs carry no question. */
const CONTROLS = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
  'select', 'textarea', '[role="combobox"]', '[aria-haspopup="listbox"]',
].join(', ')

function isRadio(el: Element): boolean {
  return el.tagName === 'INPUT' && (el.getAttribute('type') ?? '').toLowerCase() === 'radio'
}

/** Whether `control` is the only Control in `question`, radios of its own name
 *  counted as that one Control. A question block that holds a group and a box
 *  besides, as Lever's pronoun question holds its free-text box, is not the
 *  box's own question. */
function holdsOnly(question: Element, control: Element): boolean {
  const name = control.getAttribute('name') ?? ''
  return Array.from(question.querySelectorAll(CONTROLS)).every((other) =>
    other === control || (isRadio(control) && isRadio(other) && name !== '' && other.getAttribute('name') === name))
}

/** The label block's text, without the mark Lever puts beside a required question. */
function questionText(block: Element): string {
  const copy = block.cloneNode(true) as Element
  for (const mark of Array.from(copy.querySelectorAll('.required'))) mark.remove()
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Where a Lever question's text sits: in the label block of the question that
 * holds the Control. Lever's own wrapping label is the polluted one: for the
 * Resume it holds the button's words and the upload messages, for a dropdown
 * every Option, for the location its widget's messages. Written from the three
 * Lever fixtures in e2e/fixtures/real (ADR 0007).
 */
function leverLabel(control: Element): ModuleLabel | null {
  const question = control.closest('.application-question')
  if (question === null || !holdsOnly(question, control)) return null
  const block = question.querySelector('.application-label')
  if (block === null || block.contains(control)) return null
  const text = questionText(block)
  return text === '' ? null : { text, element: block }
}

/** Where the Job posting text sits on a Lever posting page: the posting's
 *  wrapper, which holds its headline and categories, its description and its
 *  lists, and none of the page's footer. Written from the Lever posting fixture
 *  in e2e/fixtures/postings (ADR 0007). */
const POSTING_SPOT = '.posting-page'

/**
 * A Lever apply page holds no Job posting text: the text is one page back. The
 * posting's address is the apply address without its last segment,
 * `/<company>/<posting>/apply` to `/<company>/<posting>`, with no query. Any
 * other Lever address gives nothing.
 */
function leverPostingPage(formPageUrl: string): PostingPage | null {
  let url: URL
  try { url = new URL(formPageUrl) } catch { return null }
  const segments = url.pathname.split('/').filter((s) => s !== '')
  if (segments.length < 3 || segments[segments.length - 1] !== 'apply') return null
  return { url: `${url.origin}/${segments.slice(0, -1).join('/')}`, spot: POSTING_SPOT }
}

/** Lever. Its climb to a checkbox group's question is already on the generic
 *  path and stays there (ADR 0007, amended). */
export const lever: AtsModule = Object.freeze({
  id: 'lever',
  labelRule: leverLabel,
  jobText: { postingPage: leverPostingPage },
  emptyStateHint: 'On Lever the form opens from "Apply for this job". Open it, then Scan again.',
})
